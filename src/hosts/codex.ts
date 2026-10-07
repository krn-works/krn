// Owns one ephemeral Codex process per stable session ID. ADR 0001.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const outputLimit = 1024 * 1024;
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
  readonly reason: string;
  readonly claimsDone: boolean;
  readonly exitCode: number | null;
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
};

export class CodexHost {
  readonly #executable: string;
  readonly #sessions = new Map<string, RunningSession>();

  constructor(options: { readonly executable?: string } = {}) {
    this.#executable = options.executable ?? defaultCodexExecutable;
  }

  async start(input: CodexStartInput): Promise<CodexSession> {
    const id = randomUUID();
    const child = spawn(
      this.#executable,
      [
        'exec',
        '--json',
        '--ephemeral',
        '--model',
        input.model,
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
    child.stdin?.end(input.prompt);
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
}

export function parseCodexOutput(stdout: string): {
  readonly threadId?: string;
  readonly finalMessage?: string;
  readonly usage: CodexUsage;
  readonly error?: string;
} {
  let threadId: string | undefined;
  let finalMessage: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(line) as unknown);
    } catch {
      return {
        usage: { inputTokens, outputTokens, totalTokens },
        error: 'codex emitted malformed JSONL',
      };
    }
    if (
      event.type === 'thread.started' &&
      typeof event.thread_id === 'string'
    ) {
      threadId = event.thread_id;
    }
    if (event.type === 'item.completed') {
      const item = record(event.item);
      if (item.type === 'agent_message' && typeof item.text === 'string')
        finalMessage = item.text;
    }
    if (event.type === 'turn.completed') {
      const usage = record(event.usage);
      inputTokens += tokenCount(usage.input_tokens);
      outputTokens += tokenCount(usage.output_tokens);
      totalTokens += tokenCount(usage.total_tokens);
    }
  }
  return {
    ...(threadId === undefined ? {} : { threadId }),
    ...(finalMessage === undefined ? {} : { finalMessage }),
    usage: { inputTokens, outputTokens, totalTokens },
  };
}

class RunningSession {
  readonly #id: string;
  readonly #child: ChildProcess;
  readonly #close: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly #closedListeners: (() => void)[] = [];
  #stdout = '';
  #stderr = '';
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
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      this.#stdout = appendBounded(this.#stdout, chunk, outputLimit, this);
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      this.#stderr = appendBounded(this.#stderr, chunk, outputLimit, this);
    });
  }

  onClose(listener: () => void): void {
    this.#closedListeners.push(listener);
  }

  markOverflow(): void {
    if (this.#overflow) return;
    this.#overflow = true;
    void this.cancel();
  }

  wait(): Promise<CodexSessionResult> {
    this.#result ??= this.#close.then(({ code, signal }) => {
      const parsed = parseCodexOutput(this.#stdout);
      const reason = this.#overflow
        ? 'codex output exceeded the bounded envelope'
        : (parsed.error ??
          parsed.finalMessage ??
          (this.#stderr.trim() || `codex exited ${String(code ?? signal)}`));
      return {
        sessionId: this.#id,
        ...(parsed.threadId === undefined ? {} : { threadId: parsed.threadId }),
        reason,
        claimsDone: code === 0 && !this.#overflow,
        exitCode: code,
        usage: parsed.usage,
      };
    });
    return this.#result;
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

function appendBounded(
  current: string,
  chunk: string,
  limit: number,
  session: RunningSession,
): string {
  if (current.length + chunk.length > limit) {
    session.markOverflow();
    return current;
  }
  return current + chunk;
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
