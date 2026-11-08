import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { rpcErrorCode } from '../worker/failure.ts';
import {
  assertServerIdentity,
  executablePath,
  findServerIdentity,
} from '../worker/process.ts';
import { alive, type Session, WorkerError } from '../worker/state.ts';
import { workerTmp } from '../worker/trust.ts';
import { defaultCodexExecutable, workerEnvironment } from './codex.ts';
import {
  spawnSystemdScope,
  systemdScopeActive,
  userManagerEnvironment,
} from './systemd-scope.ts';

// The persisted unit and detached process group survive a driver SIGKILL.
export async function reapAppServer(
  state: Pick<
    Session,
    | 'unit'
    | 'serverPid'
    | 'serverStartTime'
    | 'serverExecutable'
    | 'serverGroup'
  >,
  run: string,
  allowMissing = false,
): Promise<void> {
  assertServerIdentity(state, run, defaultCodexExecutable, allowMissing);
  const { unit, serverPid: pid } = state;
  // No asynchronous boundary between the identity check and signalling.
  spawnSync('systemctl', ['--user', 'stop', unit], {
    env: userManagerEnvironment(),
    stdio: 'ignore',
    timeout: 5000,
  });
  if (assertServerIdentity(state, run, defaultCodexExecutable, true)) {
    try {
      process.kill(-state.serverGroup, 'SIGKILL');
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
      )
        throw error;
    }
  }
  const deadline = Date.now() + 5000;
  while (alive(pid) || systemdScopeActive(unit) !== false) {
    if (Date.now() >= deadline)
      throw new WorkerError(70, 'worker server cleanup failed');
    await delay(10);
  }
}

const envelopeSchema = z
  .object({
    id: z.union([z.string().max(256), z.number().int().safe()]).optional(),
    method: z.string().max(256).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .refine((v) => v.id !== undefined || v.method !== undefined);
type Notification = z.infer<typeof envelopeSchema>;
export class CodexAppServer {
  readonly child: ReturnType<typeof spawnSystemdScope>;
  readonly unit: string;
  readonly run: string;
  readonly executable: string;
  identity: ReturnType<typeof findServerIdentity>;
  readonly notifications: Notification[] = [];
  approvalRequested = false;
  error: WorkerError | undefined;
  #sequence = 0;
  #buffer = Buffer.alloc(0);
  #stderrBytes = 0;
  #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: WorkerError) => void }
  >();
  constructor(
    executable: string,
    repo: string,
    run: string,
    unit: string,
    onNotification: (event: Notification) => void,
  ) {
    this.unit = unit;
    this.run = run;
    this.executable = executablePath(executable);
    this.child = spawnSystemdScope(
      unit,
      this.executable,
      ['app-server', '--listen', 'stdio://'],
      {
        cwd: repo,
        detached: true,
        stdio: 'pipe',
        env: { ...workerEnvironment(), TMPDIR: workerTmp(run) },
      },
    );
    this.child.on('error', () =>
      this.fail(new WorkerError(75, 'app-server launch failed')),
    );
    this.child.on('close', (status, signal) =>
      this.fail(
        new WorkerError(75, 'app-server disconnected', {
          class: 'appServerExited',
          retryable: false,
          exit_status: status,
          signal,
        }),
      ),
    );
    this.child.stdin?.on('error', () =>
      this.fail(new WorkerError(75, 'app-server input closed')),
    );
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.#stderrBytes += chunk.length;
      if (this.#stderrBytes > 1024 * 1024)
        this.fail(new WorkerError(65, 'app-server stderr limit exceeded'));
    });
    this.child.stdout?.on('data', (chunk: Buffer) => {
      if (this.error && !this.#pending.size) return;
      try {
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        let end = this.#buffer.indexOf(10);
        while (end >= 0) {
          const line = this.#buffer.subarray(0, end);
          this.#buffer = this.#buffer.subarray(end + 1);
          if (
            line.length > 8 * 1024 * 1024 ||
            line.includes(13) ||
            line.subarray(0, 3).equals(Buffer.from([239, 187, 191]))
          )
            throw new Error('line');
          const event = envelopeSchema.parse(JSON.parse(line.toString('utf8')));
          if (event.method && event.id !== undefined) this.decline(event);
          else if (event.id !== undefined) {
            const pending =
              typeof event.id === 'number'
                ? this.#pending.get(event.id)
                : undefined;
            if (!pending) throw new Error('unknown response');
            this.#pending.delete(Number(event.id));
            if (event.error !== undefined) {
              const code = rpcErrorCode(event.error);
              pending.reject(
                new WorkerError(70, 'app-server request failed', {
                  class: 'requestFailed',
                  retryable: false,
                  ...(code === undefined ? {} : { code }),
                }),
              );
            } else pending.resolve(event.result);
          } else {
            if (
              event.method === 'turn/completed' ||
              event.method === 'thread/compacted' ||
              (event.method === 'item/completed' &&
                z
                  .object({ type: z.literal('contextCompaction') })
                  .safeParse(event.params?.item).success)
            ) {
              this.notifications.push(event);
              if (this.notifications.length > 8) this.notifications.shift();
            }
            onNotification(event);
          }
          if (this.error) return;
          end = this.#buffer.indexOf(10);
        }
        if (this.#buffer.length > 8 * 1024 * 1024)
          this.fail(
            new WorkerError(65, 'app-server JSON-RPC line limit exceeded'),
          );
      } catch (error) {
        this.fail(
          error instanceof WorkerError
            ? error
            : new WorkerError(65, 'malformed app-server JSON-RPC line'),
        );
      }
    });
  }
  async identify(): Promise<NonNullable<typeof this.identity>> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const pid = this.child.pid;
      if (!pid) throw new WorkerError(65, 'worker launcher identity missing');
      this.identity ??= findServerIdentity(pid, this.executable);
      if (this.identity) return this.identity;
      if (!alive(pid) || Date.now() >= deadline)
        throw new WorkerError(65, 'worker app-server identity missing');
      await delay(10);
    }
  }
  fail(error: WorkerError): void {
    this.error ??= error;
    for (const pending of this.#pending.values()) pending.reject(this.error);
    this.#pending.clear();
  }
  write(value: unknown, force = false): void {
    if (!this.error || force)
      this.child.stdin?.write(`${JSON.stringify(value)}\n`);
  }
  decline(event: Notification): void {
    this.approvalRequested = true;
    let result: unknown = {
      decision:
        event.method === 'execCommandApproval' ||
        event.method === 'applyPatchApproval'
          ? 'denied'
          : 'decline',
    };
    if (event.method === 'item/permissions/requestApproval')
      result = { permissions: {}, scope: 'turn' };
    if (event.method === 'item/tool/requestUserInput') result = { answers: {} };
    if (event.method === 'mcpServer/elicitation/request')
      result = { action: 'decline' };
    this.write({ id: event.id, result });
    this.fail(new WorkerError(70, 'approval_requested; round declined'));
  }
  async request(
    method: string,
    params: unknown,
    timeoutMs = 15000,
  ): Promise<unknown> {
    if (this.error && method !== 'turn/interrupt') throw this.error;
    const id = ++this.#sequence;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
        this.#pending.set(id, { resolve, reject });
        timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new WorkerError(124, `app-server request timeout: ${method}`));
        }, timeoutMs);
        this.write({ id, method, params }, method === 'turn/interrupt');
      });
    } finally {
      clearTimeout(timer);
    }
  }
  async wait(
    predicate: (event: Notification) => boolean,
    timeoutMs: number,
    stopped = () => false,
  ): Promise<Notification> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.error) throw this.error;
      if (stopped()) throw new WorkerError(75, 'worker stopped');
      const event = this.notifications.find(predicate);
      if (event) return event;
      if (Date.now() >= deadline)
        throw new WorkerError(124, 'worker turn timeout');
      await delay(10);
    }
  }
  async close(): Promise<void> {
    const closed = new Promise<void>((done) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null)
        done();
      else this.child.once('close', () => done());
    });
    if (!this.identity && alive(this.child.pid ?? 0)) await this.identify();
    if (this.identity)
      await reapAppServer(
        { ...this.identity, unit: this.unit },
        this.run,
        true,
      );
    await closed;
  }
}
