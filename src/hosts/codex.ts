// Owns one ephemeral Codex process per stable session ID. ADR 0001.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

const lineLimit = 256 * 1024;
const killGraceMs = 1000;
const codexRecord = z.record(z.string(), z.unknown());
const tokenValue = z.number().int().nonnegative().safe();
const namespaceCleanupGraceMs = 1000;

export type CodexIsolationMode = 'pid_namespace' | 'proc_tree_fallback';
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
    readonly intent: string;
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
    const checkpoint = input.checkpoint
      ? `\n\nWhen you reach a checkpoint, run exactly: ${[
          process.execPath,
          input.checkpoint.cli,
          'checkpoint',
          '--job',
          input.checkpoint.job,
          '--issue',
          input.checkpoint.issue,
          '--worktree',
          input.checkpoint.worktree,
          '--intent',
          input.checkpoint.intent,
          '--session',
          id,
        ]
          .map(shellQuote)
          .join(
            ' ',
          )} --next "<one line>"\nIf needed, add --decision "<one line>".`
      : '';
    const prompt = `${input.prompt}${checkpoint}\n\nAfter saving a checkpoint, finish this turn immediately.`;
    const gitDir = resolve(input.cwd, gitCommonDir(input.cwd));
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
      '--add-dir',
      gitDir,
      '--cd',
      input.cwd,
      '--color',
      'never',
      '-',
    ];
    const launcher =
      isolation === 'pid_namespace'
        ? this.#namespaceLauncher
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
        : codexArgs;
    const child = spawn(launcher, launcherArgs, {
      cwd: input.cwd,
      detached: process.platform !== 'win32',
      stdio: 'pipe',
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
    );
    this.#sessions.set(id, running);
    child.once('close', () => this.#sessions.delete(id));
    if (input.onStarted && !(await input.onStarted(id, child.pid, isolation))) {
      await running.cancel();
      throw new Error('session intent was already started');
    }
    child.stdin?.end(prompt);
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
  readonly #descendants = new Map<number, string>();
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
  #descendantTracker: NodeJS.Timeout | undefined;
  #result?: Promise<CodexSessionResult>;

  constructor(
    id: string,
    child: ChildProcess,
    isolation: CodexIsolationMode,
    namespace?: string,
    namespaceInitPid?: number,
  ) {
    this.#id = id;
    this.#child = child;
    this.#isolation = isolation;
    this.#namespace = namespace;
    this.#namespaceInitPid = namespaceInitPid;
    if (isolation === 'proc_tree_fallback' && child.pid !== undefined) {
      this.captureDescendants();
      this.#descendantTracker = setInterval(
        () => this.captureDescendants(),
        50,
      );
      this.#descendantTracker.unref();
    }
    this.#close = new Promise((resolve) => {
      let finished = false;
      const finish = async (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        if (finished) return;
        finished = true;
        if (this.#descendantTracker) clearInterval(this.#descendantTracker);
        if (this.#isolation === 'proc_tree_fallback')
          await this.reapDescendants();
        if (this.#namespace) await waitForNamespaceExit(this.#namespace);
        for (const listener of this.#closedListeners) listener();
        resolve({ code, signal });
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
        claimsDone:
          code === 0 &&
          !this.#overflow &&
          !this.#malformed &&
          Boolean(this.#finalMessage),
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
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
      await this.#close;
      return;
    }
    if (this.#isolation === 'pid_namespace' && this.#namespaceInitPid)
      signalPid(this.#namespaceInitPid, 'SIGTERM');
    else {
      this.captureDescendants();
      signalTree(this.#child, 'SIGTERM');
      this.signalDescendants('SIGTERM');
    }
    const closed = await Promise.race([
      this.#close.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), killGraceMs),
      ),
    ]);
    if (!closed) {
      if (this.#isolation === 'pid_namespace' && this.#namespaceInitPid)
        signalPid(this.#namespaceInitPid, 'SIGKILL');
      else {
        this.captureDescendants();
        this.signalDescendants('SIGKILL');
        signalTree(this.#child, 'SIGKILL');
      }
    }
    await this.#close;
  }

  private captureDescendants(): void {
    if (this.#child.pid === undefined) return;
    for (const [pid, info] of procDescendants(this.#child.pid))
      this.#descendants.set(pid, info.startTime);
  }

  private signalDescendants(signal: NodeJS.Signals): void {
    for (const [pid, startTime] of this.#descendants) {
      if (procInfo(pid)?.startTime === startTime) signalPid(pid, signal);
    }
  }

  private async reapDescendants(): Promise<void> {
    while (this.#descendants.size) {
      this.captureDescendants();
      for (const [pid, startTime] of this.#descendants) {
        if (procInfo(pid)?.startTime !== startTime)
          this.#descendants.delete(pid);
        else signalPid(pid, 'SIGKILL');
      }
      if (this.#descendants.size) await delay(20);
    }
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
  if (process.platform !== 'linux') return 'proc_tree_fallback';
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
  return !result.error && result.status === 0
    ? 'pid_namespace'
    : 'proc_tree_fallback';
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

function procInfo(
  pid: number,
): { readonly parent: number; readonly startTime: string } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    const parent = Number(fields[1]);
    const startTime = fields[19];
    return Number.isSafeInteger(parent) && startTime
      ? { parent, startTime }
      : undefined;
  } catch {
    return undefined;
  }
}

function procDescendants(
  rootPid: number,
): Map<number, { readonly startTime: string }> {
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return new Map();
  }
  const snapshot = new Map<
    number,
    { readonly parent: number; readonly startTime: string }
  >();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const info = procInfo(Number(entry));
    if (info) snapshot.set(Number(entry), info);
  }
  const tree = new Set([rootPid]);
  for (;;) {
    let changed = false;
    for (const [pid, info] of snapshot) {
      if (!tree.has(pid) && tree.has(info.parent)) {
        tree.add(pid);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return new Map(
    [...tree]
      .filter((pid) => pid !== rootPid)
      .flatMap((pid) => {
        const info = snapshot.get(pid);
        return info ? [[pid, { startTime: info.startTime }] as const] : [];
      }),
  );
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

function gitCommonDir(cwd: string): string {
  const result = spawnSync(
    'git',
    ['-C', cwd, 'rev-parse', '--git-common-dir'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || 'unable to find git directory');
  const path = result.stdout.trim();
  return isAbsolute(path) ? path : resolve(cwd, path);
}
