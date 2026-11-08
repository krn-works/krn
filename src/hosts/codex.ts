// Owns one ephemeral Codex process per stable session ID. ADR 0001.
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { CodexJsonlReader } from './codex-jsonl.ts';
import {
  assertSystemdUserScopesAvailable,
  codexScopeRuntimeProperties,
  codexScopeUnit,
  drainSystemdScope,
  processHasIdentity,
  processStartTicks,
  type ReapedSystemdScope,
  reapOrphanedCodexScopes,
  type SystemdScopeRegistration,
  spawnSystemdScope,
  systemdScopeActive,
  userManagerEnvironment,
  validateSystemdScopeRegistration,
  waitForSystemdScopeRegistration,
} from './systemd-scope.ts';

const killGraceMs = 1000;
const transportCloseGraceMs = 3000;
const codexRecord = z.record(z.string(), z.unknown());
const tokenValue = z.number().int().nonnegative().safe();
const workerEnvironmentKeys = new Set([
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
]);

type CodexIsolationMode = 'systemd_scope';
type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export function workerEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      (workerEnvironmentKeys.has(key) ||
        key.startsWith('CODEX_') ||
        key.startsWith('OPENAI_'))
    )
      env[key] = value;
  }
  return env;
}

type CodexRelease = { readonly executable: string; readonly version: string };

/** Installed Codex releases with an executable, newest first; undefined when none are installed. */
function codexReleases(home: string): CodexRelease[] | undefined {
  const releases = join(home, '.codex/packages/app-server-daemon/releases');
  if (!existsSync(releases)) return undefined;
  return readdirSync(releases, { withFileTypes: true })
    .flatMap((entry) => {
      const match = /^(\d+)\.(\d+)\.(\d+)-[0-9A-Za-z][0-9A-Za-z._-]*$/.exec(
        entry.name,
      );
      if (!entry.isDirectory() || !match) return [];
      const executable = join(releases, entry.name, 'bin/codex');
      return existsSync(executable)
        ? [
            {
              executable,
              version: `${match[1]}.${match[2]}.${match[3]}`,
              parts: [Number(match[1]), Number(match[2]), Number(match[3])],
            },
          ]
        : [];
    })
    .sort(
      (left, right) =>
        (right.parts[0] ?? 0) - (left.parts[0] ?? 0) ||
        (right.parts[1] ?? 0) - (left.parts[1] ?? 0) ||
        (right.parts[2] ?? 0) - (left.parts[2] ?? 0),
    )
    .map(({ executable, version }) => ({ executable, version }));
}

export function resolveCodexExecutable(home: string = homedir()): string {
  const override = process.env.KRN_CODEX_BIN;
  if (override) return override;
  return codexReleases(home)?.[0]?.executable ?? 'codex';
}

/**
 * The Codex receiver for a worker: the operator override or `codex` on PATH
 * (version unknown until probed), else the newest installed release whose
 * version is in `supported`; undefined when releases exist but none is supported.
 */
export function resolveSupportedCodex(
  supported: readonly string[],
  home: string = homedir(),
): { readonly executable: string; readonly version?: string } | undefined {
  const override = process.env.KRN_CODEX_BIN;
  if (override) return { executable: override };
  const releases = codexReleases(home);
  if (!releases?.length) return { executable: 'codex' };
  return releases.find((release) => supported.includes(release.version));
}

export const defaultCodexExecutable: string = resolveCodexExecutable();

type CodexUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly reasoningOutputTokens?: number;
};

export type CodexSessionResult = {
  readonly sessionId: string;
  readonly threadId?: string;
  readonly reasonKind: string;
  readonly reasonSha256: string;
  readonly reasonLength: number;
  readonly claimsDone: boolean;
  readonly reapedScopes?: readonly ReapedSystemdScope[];
  readonly finalMessage?: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly usage: CodexUsage;
  readonly usageObservation: {
    readonly turnsStarted: number;
    readonly turnsCompleted: number;
    readonly invalidFields: number;
    readonly reportedFields?: readonly string[];
    readonly missingRequiredTurns?: number;
  };
};

export type CodexSession = {
  readonly id: string;
  wait(): Promise<CodexSessionResult>;
};

export type CodexStartInput = {
  readonly cwd: string;
  readonly model: 'gpt-6-luna';
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly disableProjectDocs?: boolean;
  readonly sandbox?: 'read-only' | 'workspace-write';
  readonly signal?: AbortSignal;
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
    registration?: SystemdScopeRegistration,
  ) => Promise<boolean>;
  readonly onStartCancelled?: (sessionId: string) => Promise<void>;
};

export class CodexHost {
  readonly #executable: string;
  readonly #drainQuietMs: number | undefined;
  readonly #sessions = new Map<string, RunningSession>();

  constructor(
    options: {
      readonly executable?: string;
      /** How long a closed session's scope must stay empty; tests shorten the production default. */
      readonly drainQuietMs?: number;
    } = {},
  ) {
    this.#executable = options.executable ?? defaultCodexExecutable;
    this.#drainQuietMs = options.drainQuietMs;
  }

  async start(input: CodexStartInput): Promise<CodexSession> {
    if (input.signal?.aborted)
      throw new Error('Codex startup was cancelled before launch');
    const id = randomUUID();
    const isolation: CodexIsolationMode = detectIsolationMode();
    const reapedScopes = await reapOrphanedCodexScopes();
    if (input.signal?.aborted)
      throw new Error('Codex startup was cancelled before launch');
    const scope = scopeName(input, id);
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
      `model_reasoning_effort=${input.reasoningEffort ?? 'high'}`,
      ...(input.disableProjectDocs ? ['-c', 'project_doc_max_bytes=0'] : []),
      '--sandbox',
      input.sandbox ?? 'workspace-write',
      '--cd',
      input.cwd,
      ...(input.checkpoint && existsSync(join(input.cwd, '.krn'))
        ? ['--add-dir', join(input.cwd, '.krn')]
        : []),
      '--color',
      'never',
      '-',
    ];
    const child = spawnSystemdScope(scope, this.#executable, codexArgs, {
      cwd: input.cwd,
      detached: true,
      stdio: 'pipe',
      env: userManagerEnvironment(workerEnvironment()),
      systemdProperties: codexScopeRuntimeProperties(input.limits.timeoutMs),
    });
    const running = new RunningSession(
      id,
      child,
      scope,
      reapedScopes,
      this.#drainQuietMs,
    );
    this.#sessions.set(id, running);
    const onAbort = () => void running.cancel().catch(() => undefined);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    let startupPending = true;
    running.onClose(() => {
      input.signal?.removeEventListener('abort', onAbort);
      if (!startupPending && running.cleanupSettled && running.cleanupVerified)
        this.#sessions.delete(id);
    });
    try {
      let registration: SystemdScopeRegistration | undefined;
      try {
        registration = await waitForSystemdScopeRegistration(
          scope,
          () => running.cancelled || running.closed,
        );
        running.setScopeRegistration(registration);
      } catch (error) {
        await rejectUnstartedSession(running, error);
      }
      if (running.cancelled)
        await rejectStartedSession(
          running,
          id,
          new Error('Codex startup was cancelled'),
          input.onStartCancelled,
        );
      if (input.onStarted) {
        let accepted = false;
        try {
          accepted = await input.onStarted(
            id,
            child.pid,
            isolation,
            registration,
          );
        } catch (error) {
          await rejectStartedSession(
            running,
            id,
            error,
            input.onStartCancelled,
          );
        }
        if (!accepted)
          await rejectStartedSession(
            running,
            id,
            new Error('session intent was already started'),
            input.onStartCancelled,
          );
      }
      if (running.cancelled)
        await rejectStartedSession(
          running,
          id,
          new Error('Codex startup was cancelled'),
          input.onStartCancelled,
        );
      if (child.stdin) {
        child.stdin.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EPIPE') child.kill('SIGTERM');
        });
        child.stdin.end(prompt);
      }
      const timer = setTimeout(
        () => void this.cancelTree(id).catch(() => undefined),
        input.limits.timeoutMs,
      );
      timer.unref();
      running.onClose(() => clearTimeout(timer));
      return { id, wait: () => running.wait() };
    } finally {
      startupPending = false;
      if (running.closed) input.signal?.removeEventListener('abort', onAbort);
      if (running.cleanupSettled && running.cleanupVerified)
        this.#sessions.delete(id);
    }
  }

  async cancelTree(sessionId: string): Promise<void> {
    const running = this.#sessions.get(sessionId);
    if (running) await running.cancel();
  }

  sessionScopeActive(
    jobId: string,
    sessionId: string,
    registration: unknown,
  ): boolean | null {
    let expectedUnit: string;
    try {
      expectedUnit = codexScopeUnit(jobId, sessionId);
    } catch {
      return null;
    }
    const validated = validateSystemdScopeRegistration(
      registration,
      expectedUnit,
    );
    if (!validated) return null;
    return systemdScopeActive(
      expectedUnit,
      userManagerEnvironment(),
      validated,
    );
  }

  async cancelAll(): Promise<void> {
    await Promise.all(
      [...this.#sessions.keys()].map((id) => this.cancelTree(id)),
    );
  }
}

async function rejectUnstartedSession(
  running: RunningSession,
  cause: unknown,
): Promise<never> {
  try {
    await running.cancel();
  } catch (cleanupError) {
    throw new AggregateError(
      [cause, cleanupError],
      'Codex registration failure cleanup could not be verified',
    );
  }
  throw cause;
}

async function rejectStartedSession(
  running: RunningSession,
  sessionId: string,
  cause: unknown,
  onStartCancelled?: (sessionId: string) => Promise<void>,
): Promise<never> {
  try {
    await running.cancel();
  } catch (cleanupError) {
    throw new AggregateError(
      [cause, cleanupError],
      'Codex startup cancellation could not be verified',
    );
  }
  try {
    await onStartCancelled?.(sessionId);
  } catch (handbackError) {
    throw new AggregateError(
      [cause, handbackError],
      'Codex startup cancellation handback failed',
    );
  }
  throw cause;
}

class RunningSession {
  readonly #id: string;
  readonly #child: ChildProcess;
  readonly #scope: string;
  #scopeRegistration: SystemdScopeRegistration | undefined;
  readonly #reapedScopes: readonly ReapedSystemdScope[];
  readonly #scopeEnvironment: NodeJS.ProcessEnv;
  #launcherStartTicks: string | undefined;
  #closed = false;
  #cleanupSettled = false;
  #cleanupVerified = false;
  #cancelled = false;
  #cancelPromise: Promise<void> | undefined;
  readonly #exit: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly #transportClose: Promise<void>;
  readonly #close: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly #closedListeners: (() => void)[] = [];
  readonly #lineReader: CodexJsonlReader;
  #threadId: string | undefined;
  #finalMessage: { hash: string; length: number; text: string } | undefined;
  #pendingTurnMessage:
    | { hash: string; length: number; text: string }
    | undefined;
  #completedTurnMessage:
    | { hash: string; length: number; text: string }
    | undefined;
  #stderrHash = createHash('sha256');
  #stderrLength = 0;
  #malformed = false;
  #reportedUsageFields = new Set<string>();
  #extraUsage: Partial<
    Record<
      'cachedInputTokens' | 'cacheWriteInputTokens' | 'reasoningOutputTokens',
      number
    >
  > = {};
  #inputTokens = 0;
  #outputTokens = 0;
  #turnsStarted = 0;
  #turnsCompleted = 0;
  #invalidUsageFields = 0;
  #missingRequiredTurns = 0;
  #result?: Promise<CodexSessionResult>;

  setScopeRegistration(registration: SystemdScopeRegistration): void {
    this.#scopeRegistration = registration;
  }

  constructor(
    id: string,
    child: ChildProcess,
    scope: string,
    reapedScopes: readonly ReapedSystemdScope[] = [],
    drainQuietMs?: number,
  ) {
    this.#id = id;
    this.#child = child;
    this.#scope = scope;
    this.#reapedScopes = reapedScopes;
    this.#scopeEnvironment = userManagerEnvironment();
    this.#lineReader = new CodexJsonlReader((line) => this.consumeLine(line));
    this.#launcherStartTicks =
      child.pid === undefined ? undefined : processStartTicks(child.pid);
    let resolveExit!: (value: {
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }) => void;
    this.#exit = new Promise((resolve) => {
      resolveExit = resolve;
    });
    let resolveTransportClose!: () => void;
    this.#transportClose = new Promise((resolve) => {
      resolveTransportClose = resolve;
    });
    this.#close = new Promise((resolveClose, rejectClose) => {
      let exitObserved = false;
      let spawned = false;
      let finished = false;
      const finish = async (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        if (finished) return;
        finished = true;
        try {
          await drainSystemdScope(
            this.#scope,
            this.#scopeEnvironment,
            this.#scopeRegistration,
            drainQuietMs === undefined ? {} : { quietMs: drainQuietMs },
          );
          const transportClosed = await this.raceWithTimeout(
            this.#transportClose.then(() => true),
            transportCloseGraceMs,
            false,
          );
          if (!transportClosed)
            throw new Error(
              `Codex transport did not close after cleanup for ${this.#id}`,
            );
          this.#cleanupVerified = true;
          resolveClose({ code, signal });
        } catch (error) {
          rejectClose(error);
        } finally {
          this.#cleanupSettled = true;
          for (const listener of this.#closedListeners) listener();
        }
      };
      const observeExit = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        if (exitObserved) return;
        exitObserved = true;
        this.#closed = true;
        resolveExit({ code, signal });
        void finish(code, signal);
      };
      child.once('spawn', () => {
        spawned = true;
        if (child.pid !== undefined)
          this.#launcherStartTicks = processStartTicks(child.pid);
      });
      child.once('exit', observeExit);
      child.once('error', () => {
        if (!spawned) observeExit(null, null);
      });
      child.once('close', (code, signal) => {
        resolveTransportClose();
        if (!exitObserved) observeExit(code, signal);
      });
    });
    void this.#close.catch(() => undefined);
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

  get cancelled(): boolean {
    return this.#cancelled;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get cleanupSettled(): boolean {
    return this.#cleanupSettled;
  }

  get cleanupVerified(): boolean {
    return this.#cleanupVerified;
  }

  wait(): Promise<CodexSessionResult> {
    this.#result ??= this.#close.then(async ({ code, signal }) => {
      if (this.#cancelPromise) await this.#cancelPromise;
      this.#lineReader.finish();
      const finalLineLimited =
        this.#lineReader.oversizedLineCount > 0 &&
        this.#finalMessage === undefined;
      const finalMessage = this.#finalMessage;
      const reasonKind = finalLineLimited
        ? 'line_limit'
        : this.#malformed
          ? 'malformed_jsonl'
          : finalMessage
            ? 'agent_message'
            : this.#stderrLength
              ? 'stderr'
              : code === 0
                ? 'exit'
                : 'process_exit';
      const reason = finalLineLimited
        ? {
            hash: createHash('sha256').update('line_limit').digest('hex'),
            length: 10,
          }
        : (finalMessage ?? {
            hash: this.#stderrHash.digest('hex'),
            length: Math.min(this.#stderrLength, Number.MAX_SAFE_INTEGER),
          });
      const usageObservation: CodexSessionResult['usageObservation'] = {
        turnsStarted: this.#turnsStarted,
        turnsCompleted: this.#turnsCompleted,
        invalidFields: this.#invalidUsageFields,
        reportedFields: [...this.#reportedUsageFields],
        missingRequiredTurns: this.#missingRequiredTurns,
      };
      return {
        sessionId: this.#id,
        ...(this.#threadId === undefined ? {} : { threadId: this.#threadId }),
        reasonKind,
        reasonSha256: reason.hash,
        reasonLength: reason.length,
        claimsDone:
          !finalLineLimited &&
          code === 0 &&
          Boolean(this.#completedTurnMessage?.text.trim()),
        reapedScopes: this.#reapedScopes,
        ...(finalMessage === undefined
          ? {}
          : { finalMessage: finalMessage.text }),
        exitCode: code,
        signal,
        usage: {
          ...this.#extraUsage,
          inputTokens: this.#inputTokens,
          outputTokens: this.#outputTokens,
          totalTokens: safeAdd(this.#inputTokens, this.#outputTokens),
        },
        usageObservation,
      };
    });
    return this.#result;
  }

  private consume(chunk: string): void {
    this.#lineReader.consume(chunk);
  }

  private consumeLine(line: string): void {
    if (!line) return;
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(line) as unknown);
    } catch {
      this.#malformed = true;
      void this.cancel().catch(() => undefined);
      return;
    }
    if (
      event.type === 'thread.started' &&
      typeof event.thread_id === 'string' &&
      event.thread_id.length <= 256
    )
      this.#threadId = event.thread_id;
    if (event.type === 'turn.started') {
      this.#turnsStarted = safeAdd(this.#turnsStarted, 1);
      this.#pendingTurnMessage = undefined;
      this.#completedTurnMessage = undefined;
    }
    if (event.type === 'item.completed') {
      const item = record(event.item);
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        const message = {
          hash: createHash('sha256').update(item.text).digest('hex'),
          length: Buffer.byteLength(item.text),
          text: item.text,
        };
        this.#finalMessage = message;
        this.#pendingTurnMessage = message;
        this.#completedTurnMessage = undefined;
      }
    }
    if (event.type === 'turn.completed') {
      this.#turnsCompleted = safeAdd(this.#turnsCompleted, 1);
      this.#completedTurnMessage = this.#pendingTurnMessage;
      this.#pendingTurnMessage = undefined;
      const usage = record(event.usage);
      const turnValues: Partial<Record<string, number>> = {};
      for (const [wire, field] of [
        ['input_tokens', 'inputTokens'],
        ['output_tokens', 'outputTokens'],
        ['cached_input_tokens', 'cachedInputTokens'],
        ['cache_write_input_tokens', 'cacheWriteInputTokens'],
        ['reasoning_output_tokens', 'reasoningOutputTokens'],
      ] as const) {
        if (!Object.hasOwn(usage, wire)) continue;
        const parsed = tokenValue.safeParse(usage[wire]);
        if (!parsed.success) {
          this.#invalidUsageFields = safeAdd(this.#invalidUsageFields, 1);
          continue;
        }
        turnValues[field] = parsed.data;
      }
      if (
        turnValues.inputTokens === undefined ||
        turnValues.outputTokens === undefined
      )
        this.#missingRequiredTurns = safeAdd(this.#missingRequiredTurns, 1);
      const relations = [
        ['cachedInputTokens', 'inputTokens'],
        ['cacheWriteInputTokens', 'inputTokens'],
        ['reasoningOutputTokens', 'outputTokens'],
      ] as const;
      const invalidRelations = new Set<string>();
      for (const [subset, total] of relations) {
        const subsetValue = turnValues[subset];
        const totalValue = turnValues[total];
        if (
          subsetValue !== undefined &&
          (totalValue === undefined || subsetValue > totalValue)
        ) {
          invalidRelations.add(subset);
          this.#invalidUsageFields = safeAdd(this.#invalidUsageFields, 1);
        }
      }
      for (const [, field] of [
        ['input_tokens', 'inputTokens'],
        ['output_tokens', 'outputTokens'],
        ['cached_input_tokens', 'cachedInputTokens'],
        ['cache_write_input_tokens', 'cacheWriteInputTokens'],
        ['reasoning_output_tokens', 'reasoningOutputTokens'],
      ] as const) {
        const value = turnValues[field];
        if (value === undefined || invalidRelations.has(field)) continue;
        this.#reportedUsageFields.add(field);
        if (field === 'inputTokens')
          this.#inputTokens = safeAdd(this.#inputTokens, value);
        else if (field === 'outputTokens')
          this.#outputTokens = safeAdd(this.#outputTokens, value);
        else
          this.#extraUsage[field] = safeAdd(
            this.#extraUsage[field] ?? 0,
            value,
          );
      }
    }
  }

  cancel(): Promise<void> {
    this.#cancelled = true;
    this.#cancelPromise ??= this.cancelOwnedProcesses();
    return this.#cancelPromise;
  }

  private async cancelOwnedProcesses(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.signalOwnedLauncher('SIGTERM');
    } catch (error) {
      failures.push(error);
    }
    let exited = await this.waitForLauncherExit();
    if (!exited) {
      try {
        await this.signalOwnedLauncher('SIGKILL');
      } catch (error) {
        failures.push(error);
      }
      exited = await this.waitForLauncherExit();
      if (!exited)
        failures.push(
          new Error('Codex systemd-scope launcher did not exit after SIGKILL'),
        );
    }
    if (exited) {
      try {
        await this.#close;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        `Codex systemd-scope cancellation could not be verified: ${failures
          .map((failure) =>
            failure instanceof Error ? failure.message : String(failure),
          )
          .join('; ')}`,
      );
  }

  private waitForLauncherExit(): Promise<boolean> {
    return this.raceWithTimeout(
      this.#exit.then(() => true),
      killGraceMs,
      false,
    );
  }

  private async raceWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutValue: T,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async signalOwnedLauncher(signal: NodeJS.Signals): Promise<void> {
    const pid = this.#child.pid;
    if (pid === undefined || this.#closed) return;
    const deadline = Date.now() + 500;
    while (
      !this.#launcherStartTicks &&
      this.#child.exitCode === null &&
      this.#child.signalCode === null &&
      !this.#closed &&
      Date.now() < deadline
    )
      await delay(10);
    if (
      this.#child.exitCode !== null ||
      this.#child.signalCode !== null ||
      this.#closed
    )
      return;
    const startTicks = this.#launcherStartTicks;
    // The launcher may have exited (or be an unreaped zombie) before Node has
    // delivered its 'exit' event. Never signal it, but that is not a failure:
    // the caller still awaits the exit event and the scope drain.
    if (!startTicks) {
      if (processStartTicks(pid) === undefined) return;
      throw new Error(
        'Codex launcher process identity is unavailable or changed',
      );
    }
    if (!processHasIdentity(pid, startTicks)) return;
    try {
      if (process.platform !== 'win32') process.kill(-pid, signal);
      else this.#child.kill(signal);
    } catch (error) {
      if (record(error).code !== 'ESRCH') throw error;
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function detectIsolationMode(): CodexIsolationMode {
  if (process.platform !== 'linux')
    throw new Error('systemd scope isolation requires Linux');
  assertSystemdUserScopesAvailable(
    'systemd user scopes are unavailable; refusing to start worker',
  );
  return 'systemd_scope';
}

function scopeName(input: CodexStartInput, sessionId: string): string {
  const raw = input.checkpoint?.job ?? basename(input.cwd);
  return codexScopeUnit(raw, sessionId);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function record(value: unknown): Record<string, unknown> {
  const parsed = codexRecord.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function safeAdd(left: number, right: number): number {
  return Math.min(left + right, Number.MAX_SAFE_INTEGER);
}
