// Owns one ephemeral Codex process per stable session ID. ADR 0001.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';

const lineLimit = 256 * 1024;
const killGraceMs = 1000;
const codexRecord = z.record(z.string(), z.unknown());
const tokenValue = z.number().int().nonnegative().safe();
const namespaceCleanupGraceMs = 1000;

export type CodexIsolationMode = 'pid_namespace' | 'systemd_scope';
const namespaceWrapper = `
let prompt = '';
process.stdin.setEncoding('utf8').on('data', (chunk) => prompt += chunk).on('end', () => {
  const child = require('node:child_process').spawn(process.argv[1], process.argv.slice(2), { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(prompt);
  child.once('error', () => process.exit(127));
  child.once('close', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
});`;

export const defaultCodexExecutable = join(
  homedir(),
  '.codex/packages/app-server-daemon/releases/0.160.0-x86_64-unknown-linux-musl/bin/codex',
);

export type CodexUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
};

export type CodexSessionResult = {
  readonly sessionId: string;
  readonly threadId?: string;
  readonly reasonKind: string;
  readonly reasonSha256: string;
  readonly reasonLength: number;
  readonly claimsDone: boolean;
  readonly finalMessage?: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly usage: CodexUsage;
};

export type CodexSession = {
  readonly id: string;
  wait(): Promise<CodexSessionResult>;
};

export type CodexStartInput = {
  readonly cwd: string;
  readonly model: 'gpt-6-luna';
  readonly prompt: string;
  readonly limits: { readonly timeoutMs: number };
  readonly checkpoint?: {
    readonly cli: string;
    readonly job: string;
    readonly issue: string;
    readonly worktree: string;
    readonly repoRoot?: string;
    readonly intent: string;
    readonly message?: string;
    readonly next?: string;
  };
  readonly onStarted?: (
    sessionId: string,
    pgid?: number,
    isolation?: CodexIsolationMode,
  ) => Promise<boolean>;
};

export class CodexHost {
  readonly #executable: string;
  readonly #namespaceLauncher: string;
  readonly #sessions = new Map<string, RunningSession>();
  #isolationMode?: CodexIsolationMode;

  constructor(
    options: {
      readonly executable?: string;
      readonly namespaceLauncher?: string;
    } = {},
  ) {
    this.#executable = options.executable ?? defaultCodexExecutable;
    this.#namespaceLauncher = options.namespaceLauncher ?? 'unshare';
  }

  async start(input: CodexStartInput): Promise<CodexSession> {
    const id = randomUUID();
    const isolation =
      this.#isolationMode ?? detectIsolationMode(this.#namespaceLauncher);
    this.#isolationMode = isolation;
    const scope =
      isolation === 'systemd_scope' ? scopeName(input, id) : undefined;
    const checkpoint = input.checkpoint
      ? `\n\nDo not run git commands or create commits. Checkpoint records your request; the foreman commits the worktree changes. If needed, add --decision "<one line>". Execute this exact command in your terminal now, then end your turn. Do not write the command as a text response:\n${[
          process.execPath,
          input.checkpoint.cli,
          'checkpoint',
          '--job',
          input.checkpoint.job,
          '--issue',
          input.checkpoint.issue,
          '--worktree',
          input.checkpoint.worktree,
          ...(input.checkpoint.repoRoot
            ? ['--repo-root', input.checkpoint.repoRoot]
            : []),
          '--intent',
          input.checkpoint.intent,
          '--session',
          id,
        ]
          .map(shellQuote)
          .join(
            ' ',
          )} --message ${input.checkpoint.message ? shellQuote(input.checkpoint.message) : '"<conventional commit subject>"'} --next ${input.checkpoint.next ? shellQuote(input.checkpoint.next) : '"<one line | done>"'}`
      : '';
    const prompt = `${input.prompt}${checkpoint}`;
    const codexArgs = [
      'exec',
      '--json',
      '--ephemeral',
      '--model',
      input.model,
      '-c',
      'model_reasoning_effort=low',
      '--sandbox',
      'workspace-write',
      '--cd',
      input.cwd,
      ...(input.checkpoint && existsSync(join(input.cwd, '.krn'))
        ? ['--add-dir', join(input.cwd, '.krn')]
        : []),
      '--color',
      'never',
      '-',
    ];
    const launcher =
      isolation === 'pid_namespace'
        ? this.#namespaceLauncher
        : isolation === 'systemd_scope'
          ? 'systemd-run'
          : this.#executable;
    const launcherArgs =
      isolation === 'pid_namespace'
        ? [
            '--user',
            '--map-root-user',
            '--pid',
            '--fork',
            '--kill-child',
            '--',
            process.execPath,
            '-e',
            namespaceWrapper,
            this.#executable,
            ...codexArgs,
          ]
        : isolation === 'systemd_scope'
          ? [
              '--user',
              '--scope',
              '--unit',
              scopeName(input, id),
              '--quiet',
              this.#executable,
              ...codexArgs,
            ]
          : codexArgs;
    const child = spawn(launcher, launcherArgs, {
      cwd: input.cwd,
      detached: process.platform !== 'win32',
      stdio: 'pipe',
      ...(isolation === 'systemd_scope'
        ? { env: userManagerEnvironment() }
        : {}),
    });
    let namespace:
      | { readonly identity: string; readonly initPid: number }
      | undefined;
    try {
      namespace =
        isolation === 'pid_namespace'
          ? await namespaceIdentity(child.pid)
          : undefined;
    } catch (error) {
      child.kill('SIGKILL');
      throw error;
    }
    const running = new RunningSession(
      id,
      child,
      isolation,
      namespace?.identity,
      namespace?.initPid,
      scope,
    );
    this.#sessions.set(id, running);
    child.once('close', () => this.#sessions.delete(id));
    if (input.onStarted && !(await input.onStarted(id, child.pid, isolation))) {
      await running.cancel();
      throw new Error('session intent was already started');
    }
    if (child.stdin) {
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') child.kill('SIGTERM');
      });
      child.stdin.end(prompt);
    }
    const timer = setTimeout(
      () => void this.cancelTree(id),
      input.limits.timeoutMs,
    );
    timer.unref();
    running.onClose(() => clearTimeout(timer));
    return { id, wait: () => running.wait() };
  }

  async cancelTree(sessionId: string): Promise<void> {
    const running = this.#sessions.get(sessionId);
    if (running) await running.cancel();
  }

  async cancelAll(): Promise<void> {
    await Promise.all(
      [...this.#sessions.keys()].map((id) => this.cancelTree(id)),
    );
  }
}

class RunningSession {
  readonly #id: string;
  readonly #child: ChildProcess;
  readonly #isolation: CodexIsolationMode;
  readonly #namespace: string | undefined;
  readonly #namespaceInitPid: number | undefined;
  readonly #scope: string | undefined;
  readonly #scopeEnvironment: NodeJS.ProcessEnv;
  readonly #close: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly #closedListeners: (() => void)[] = [];
  #lineBuffer = '';
  #threadId: string | undefined;
  #finalMessage: { hash: string; length: number; text: string } | undefined;
  #stderrHash = createHash('sha256');
  #stderrLength = 0;
  #malformed = false;
  #inputTokens = 0;
  #outputTokens = 0;
  #totalTokens = 0;
  #overflow = false;
  #result?: Promise<CodexSessionResult>;

  constructor(
    id: string,
    child: ChildProcess,
    isolation: CodexIsolationMode,
    namespace?: string,
    namespaceInitPid?: number,
    scope?: string,
  ) {
    this.#id = id;
    this.#child = child;
    this.#isolation = isolation;
    this.#namespace = namespace;
    this.#namespaceInitPid = namespaceInitPid;
    this.#scope = scope;
    this.#scopeEnvironment = userManagerEnvironment();
    this.#close = new Promise((resolveClose, rejectClose) => {
      let finished = false;
      const finish = async (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        if (finished) return;
        finished = true;
        try {
          if (this.#scope)
            await killAndVerifyScope(this.#scope, this.#scopeEnvironment);
          if (this.#namespace) await waitForNamespaceExit(this.#namespace);
          for (const listener of this.#closedListeners) listener();
          resolveClose({ code, signal });
        } catch (error) {
          rejectClose(error);
        }
      };
      child.once('close', (code, signal) => void finish(code, signal));
      child.once('error', () => void finish(null, null));
    });
    child.stdout
      ?.setEncoding('utf8')
      .on('data', (chunk: string) => this.consume(chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      this.#stderrHash.update(chunk);
      this.#stderrLength = Math.min(
        this.#stderrLength + Buffer.byteLength(chunk),
        Number.MAX_SAFE_INTEGER,
      );
    });
  }

  onClose(listener: () => void): void {
    this.#closedListeners.push(listener);
  }

  wait(): Promise<CodexSessionResult> {
    this.#result ??= this.#close.then(({ code, signal }) => {
      if (this.#lineBuffer) this.consumeLine(this.#lineBuffer);
      const reasonKind = this.#overflow
        ? 'line_limit'
        : this.#malformed
          ? 'malformed_jsonl'
          : this.#finalMessage
            ? 'agent_message'
            : this.#stderrLength
              ? 'stderr'
              : code === 0
                ? 'exit'
                : 'process_exit';
      const reason = this.#overflow
        ? {
            hash: createHash('sha256').update('line_limit').digest('hex'),
            length: 10,
          }
        : (this.#finalMessage ?? {
            hash: this.#stderrHash.digest('hex'),
            length: Math.min(this.#stderrLength, Number.MAX_SAFE_INTEGER),
          });
      return {
        sessionId: this.#id,
        ...(this.#threadId === undefined ? {} : { threadId: this.#threadId }),
        reasonKind,
        reasonSha256: reason.hash,
        reasonLength: reason.length,
        claimsDone: false,
        ...(this.#finalMessage === undefined
          ? {}
          : { finalMessage: this.#finalMessage.text }),
        exitCode: code,
        signal,
        usage: {
          inputTokens: this.#inputTokens,
          outputTokens: this.#outputTokens,
          totalTokens: this.#totalTokens,
        },
      };
    });
    return this.#result;
  }

  private consume(chunk: string): void {
    this.#lineBuffer += chunk;
    for (;;) {
      const newline = this.#lineBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.#lineBuffer.slice(0, newline).replace(/\r$/, '');
      this.#lineBuffer = this.#lineBuffer.slice(newline + 1);
      this.consumeLine(line);
    }
    if (Buffer.byteLength(this.#lineBuffer) > lineLimit) {
      this.#overflow = true;
      void this.cancel();
    }
  }

  private consumeLine(line: string): void {
    if (Buffer.byteLength(line) > lineLimit) {
      this.#overflow = true;
      void this.cancel();
      return;
    }
    if (!line) return;
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(line) as unknown);
    } catch {
      this.#malformed = true;
      void this.cancel();
      return;
    }
    if (
      event.type === 'thread.started' &&
      typeof event.thread_id === 'string' &&
      event.thread_id.length <= 256
    )
      this.#threadId = event.thread_id;
    if (event.type === 'item.completed') {
      const item = record(event.item);
      if (item.type === 'agent_message' && typeof item.text === 'string')
        this.#finalMessage = {
          hash: createHash('sha256').update(item.text).digest('hex'),
          length: Buffer.byteLength(item.text),
          text: item.text,
        };
    }
    if (event.type === 'turn.completed') {
      const usage = record(event.usage);
      this.#inputTokens = safeAdd(
        this.#inputTokens,
        tokenCount(usage.input_tokens),
      );
      this.#outputTokens = safeAdd(
        this.#outputTokens,
        tokenCount(usage.output_tokens),
      );
      this.#totalTokens = safeAdd(
        this.#totalTokens,
        tokenCount(usage.total_tokens),
      );
    }
  }

  async cancel(): Promise<void> {
    if (this.#scope) {
      await killAndVerifyScope(this.#scope, this.#scopeEnvironment);
      await this.#close;
      return;
    }
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
      await this.#close;
      return;
    }
    if (this.#isolation === 'pid_namespace' && this.#namespaceInitPid)
      signalPid(this.#namespaceInitPid, 'SIGTERM');
    else signalTree(this.#child, 'SIGTERM');
    const closed = await Promise.race([
      this.#close.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), killGraceMs),
      ),
    ]);
    if (!closed) {
      if (this.#isolation === 'pid_namespace' && this.#namespaceInitPid)
        signalPid(this.#namespaceInitPid, 'SIGKILL');
      else signalTree(this.#child, 'SIGKILL');
    }
    await this.#close;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else signalProcess(child, signal);
  } catch (error) {
    if (record(error).code !== 'ESRCH') throw error;
  }
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) signalPid(child.pid, signal);
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (record(error).code !== 'ESRCH') throw error;
  }
}

function detectIsolationMode(namespaceLauncher: string): CodexIsolationMode {
  const requested = process.env.KRN_ISOLATION;
  if (requested && requested !== 'pid_namespace')
    throw new Error(`unsupported KRN_ISOLATION: ${requested}`);
  if (requested === 'pid_namespace') {
    if (process.platform !== 'linux')
      throw new Error('PID namespace isolation requires Linux');
    const result = spawnSync(
      namespaceLauncher,
      [
        '--user',
        '--map-root-user',
        '--pid',
        '--fork',
        '--kill-child',
        '--',
        'true',
      ],
      { stdio: 'ignore', timeout: 3000 },
    );
    if (result.error || result.status !== 0)
      throw new Error('requested PID namespace isolation is unavailable');
    return 'pid_namespace';
  }
  if (process.platform !== 'linux')
    throw new Error('systemd scope isolation requires Linux');
  const unit = `krn-probe-${randomUUID()}.scope`;
  const result = spawnSync(
    'systemd-run',
    ['--user', '--scope', '--unit', unit, '--quiet', '/bin/true'],
    { stdio: 'ignore', timeout: 5000, env: userManagerEnvironment() },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      'systemd user scopes are unavailable; refusing to start worker',
    );
  return 'systemd_scope';
}

function scopeName(input: CodexStartInput, sessionId: string): string {
  const raw = input.checkpoint?.job ?? basename(input.cwd);
  const job = raw.replace(/[^A-Za-z0-9:_.-]/g, '-').slice(0, 80) || 'session';
  return `krn-${job}-${sessionId}.scope`;
}

function userManagerEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const uid = process.getuid?.();
  if (uid === undefined) return env;
  const runtime = env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
  const bus = join(runtime, 'bus');
  if (!env.XDG_RUNTIME_DIR && existsSync(runtime))
    env.XDG_RUNTIME_DIR = runtime;
  if (!env.DBUS_SESSION_BUS_ADDRESS && existsSync(bus))
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
  return env;
}

async function killAndVerifyScope(
  unit: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const killed = spawnSync(
    'systemctl',
    ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', unit],
    { encoding: 'utf8', env, timeout: 5000 },
  );
  const deadline = Date.now() + 5000;
  let lastError = killed.error?.message ?? killed.stderr.trim();
  while (Date.now() < deadline) {
    const shown = spawnSync(
      'systemctl',
      ['--user', 'show', '--property=ControlGroup', '--value', unit],
      { encoding: 'utf8', env, timeout: 3000 },
    );
    if (shown.status !== 0) {
      const detail = `${shown.stderr}\n${shown.stdout}`;
      if (/not loaded|not found|could not be found/i.test(detail)) return;
      throw new Error(`cannot verify systemd scope ${unit}: ${detail.trim()}`);
    }
    const controlGroup = shown.stdout.trim();
    if (!controlGroup) return;
    if (!controlGroup.startsWith('/') || controlGroup.split('/').includes('..'))
      throw new Error(`systemd returned an invalid cgroup path for ${unit}`);
    const cgroup = resolve('/sys/fs/cgroup', controlGroup.slice(1));
    try {
      const events = readFileSync(join(cgroup, 'cgroup.events'), 'utf8');
      if (/^populated 0$/m.test(events)) return;
      lastError = `cgroup ${controlGroup} remains populated`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await delay(20);
  }
  if (killed.status !== 0 && !lastError)
    lastError = killed.stderr || 'systemd kill command failed';
  throw new Error(`systemd scope ${unit} did not become empty: ${lastError}`);
}

async function namespaceIdentity(
  parentPid: number | undefined,
): Promise<{ readonly identity: string; readonly initPid: number }> {
  if (parentPid === undefined)
    throw new Error('namespace launcher pid is unavailable');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const child = readFileSync(
        `/proc/${parentPid}/task/${parentPid}/children`,
        'utf8',
      )
        .trim()
        .split(/\s+/)[0];
      if (child)
        return {
          identity: readlinkSync(`/proc/${child}/ns/pid`),
          initPid: Number(child),
        };
    } catch {}
    await delay(10);
  }
  throw new Error('PID namespace child did not start');
}

async function waitForNamespaceExit(namespace: string): Promise<void> {
  const grace = Date.now() + namespaceCleanupGraceMs;
  for (;;) {
    const pids = namespacePids(namespace);
    if (!pids.length) return;
    if (Date.now() >= grace) for (const pid of pids) signalPid(pid, 'SIGKILL');
    await delay(10);
  }
}

function namespacePids(namespace: string): number[] {
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!/^\d+$/.test(entry)) return [];
    try {
      return readlinkSync(`/proc/${entry}/ns/pid`) === namespace
        ? [Number(entry)]
        : [];
    } catch {
      return [];
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function record(value: unknown): Record<string, unknown> {
  const parsed = codexRecord.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function tokenCount(value: unknown): number {
  const parsed = tokenValue.safeParse(value);
  return parsed.success ? parsed.data : 0;
}

function safeAdd(left: number, right: number): number {
  return Math.min(left + right, Number.MAX_SAFE_INTEGER);
}
