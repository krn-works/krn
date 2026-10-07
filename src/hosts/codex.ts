// Owns one ephemeral Codex process per stable session ID. ADR 0001.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

const lineLimit = 256 * 1024;
const killGraceMs = 1000;
const codexRecord = z.record(z.string(), z.unknown());
const tokenValue = z.number().int().nonnegative().safe();

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
  readonly onStarted?: (sessionId: string, pgid?: number) => Promise<boolean>;
};

export class CodexHost {
  readonly #executable: string;
  readonly #sessions = new Map<string, RunningSession>();

  constructor(options: { readonly executable?: string } = {}) {
    this.#executable = options.executable ?? defaultCodexExecutable;
  }

  async start(input: CodexStartInput): Promise<CodexSession> {
    const id = randomUUID();
    const checkpoint = input.checkpoint
      ? `\n\nIf interrupted after checkpointing, run: ${process.execPath} ${input.checkpoint.cli} checkpoint --job ${input.checkpoint.job} --issue ${input.checkpoint.issue} --worktree ${input.checkpoint.worktree} --intent ${input.checkpoint.intent} --session ${id}`
      : '';
    const prompt = `${input.prompt}${checkpoint}\n\nAfter saving a checkpoint, finish this turn immediately.`;
    const gitDir = resolve(input.cwd, gitCommonDir(input.cwd));
    const child = spawn(
      this.#executable,
      [
        'exec',
        '--json',
        '--ephemeral',
        '--model',
        input.model,
        '--sandbox',
        'workspace-write',
        '--add-dir',
        gitDir,
        '--cd',
        input.cwd,
        '--color',
        'never',
        '-',
      ],
      { cwd: input.cwd, detached: process.platform !== 'win32', stdio: 'pipe' },
    );
    const running = new RunningSession(id, child);
    this.#sessions.set(id, running);
    child.once('close', () => this.#sessions.delete(id));
    if (input.onStarted && !(await input.onStarted(id, child.pid))) {
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
  readonly #close: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly #closedListeners: (() => void)[] = [];
  #lineBuffer = '';
  #threadId: string | undefined;
  #finalMessage: { hash: string; length: number } | undefined;
  #stderrHash = createHash('sha256');
  #stderrLength = 0;
  #malformed = false;
  #inputTokens = 0;
  #outputTokens = 0;
  #totalTokens = 0;
  #overflow = false;
  #result?: Promise<CodexSessionResult>;

  constructor(id: string, child: ChildProcess) {
    this.#id = id;
    this.#child = child;
    this.#close = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        for (const listener of this.#closedListeners) listener();
        resolve({ code, signal });
      });
      child.once('error', () => resolve({ code: null, signal: null }));
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
    if (this.#child.exitCode !== null || this.#child.signalCode !== null)
      return;
    signalTree(this.#child, 'SIGTERM');
    const closed = await Promise.race([
      this.#close.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), killGraceMs),
      ),
    ]);
    if (!closed) signalTree(this.#child, 'SIGKILL');
    await this.#close;
  }
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (record(error).code !== 'ESRCH') throw error;
  }
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
