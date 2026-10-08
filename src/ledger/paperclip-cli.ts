import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import {
  killAndVerifyScope,
  spawnSystemdScope,
  systemdScopeUnit,
  userManagerEnvironment,
} from '../hosts/systemd-scope.ts';
import type { LedgerTransport } from './index.ts';

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const PROCESS_GROUP_POLL_MS = 10;
const BEST_EFFORT_REAP_MS = 500;

function cliEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'PATH']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('PAPERCLIP_') && value !== undefined) env[key] = value;
  }
  return env;
}

function resolveExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv,
): string {
  if (isAbsolute(executable)) return executable;
  if (executable.includes('/')) return resolve(executable);
  for (const directory of (environment.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory || '.', executable);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error('Paperclip CLI could not be started');
}

function runPaperclip(
  args: readonly string[],
  options: {
    executable: string;
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
  },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const scope = systemdScopeUnit('paperclip');
    const environment = cliEnvironment();
    const scopeEnvironment = userManagerEnvironment(environment);
    const child = spawnSystemdScope(
      scope,
      resolveExecutable(options.executable, environment),
      args,
      {
        detached: true,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let stopping = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pid = child.pid;
    const closed = new Promise<void>((resolveClose) => {
      child.once('close', () => resolveClose());
    });
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const waitForGroupGone = async (deadline: number) => {
      if (pid === undefined) return;
      while (Date.now() < deadline) {
        try {
          process.kill(-pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
          throw error;
        }
        await new Promise((done) => setTimeout(done, PROCESS_GROUP_POLL_MS));
      }
    };
    const stopGroup = (message: string) => {
      if (settled || stopping) return;
      stopping = true;
      cleanup();
      if (pid !== undefined) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            child.kill('SIGKILL');
          }
        }
      } else {
        child.kill('SIGKILL');
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      void (async () => {
        let cleanupError: Error | undefined;
        try {
          await killAndVerifyScope(scope, scopeEnvironment);
        } catch {
          cleanupError = new Error(
            'Paperclip CLI scope could not be stopped and verified',
          );
        }
        if (!settled) {
          settled = true;
          reject(cleanupError ?? new Error(message));
        }
        const reapBy = Date.now() + BEST_EFFORT_REAP_MS;
        try {
          await Promise.race([
            closed,
            new Promise<void>((resolveReap) =>
              setTimeout(resolveReap, BEST_EFFORT_REAP_MS),
            ),
          ]);
          await waitForGroupGone(reapBy);
        } catch {
          // Cleanup is bounded and must not delay the refusal.
        }
      })();
    };
    const onAbort = () => void stopGroup('Paperclip CLI request aborted');
    const finishError = (message: string) => void stopGroup(message);
    child.on('error', () => {
      if (settled || stopping) return;
      settled = true;
      cleanup();
      reject(new Error('Paperclip CLI could not be started'));
    });
    const collect = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > options.maxOutputBytes) {
        finishError(
          `Paperclip CLI output exceeds ${options.maxOutputBytes} bytes`,
        );
        return;
      }
      chunks.push(chunk);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    timer = setTimeout(
      () =>
        finishError(`Paperclip CLI timed out after ${options.timeoutMs} ms`),
      options.timeoutMs,
    );
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.on('close', (code) => {
      if (settled || stopping) return;
      settled = true;
      cleanup();
      if (code !== 0) {
        reject(new Error('Paperclip CLI command failed'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        reject(new Error('Paperclip CLI returned invalid JSON'));
      }
    });
  });
}

function normalizeIssueIdentifier(issueId: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return value;
  const issue = value as Record<string, unknown>;
  return issue.identifier === issueId && typeof issue.id === 'string'
    ? { ...issue, id: issueId }
    : value;
}

function validIssueId(issueId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(issueId))
    throw new Error('invalid Paperclip issue ID');
}

export function createPaperclipCliTransport(
  configuration: {
    executable?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    signal?: AbortSignal;
  } = {},
): LedgerTransport {
  const configurationSignal = configuration.signal;
  const stopController = new AbortController();
  const signal = configurationSignal
    ? AbortSignal.any([configurationSignal, stopController.signal])
    : stopController.signal;
  const options = {
    executable: configuration.executable ?? 'paperclip',
    timeoutMs: configuration.timeoutMs ?? TIMEOUT_MS,
    maxOutputBytes: configuration.maxOutputBytes ?? MAX_OUTPUT_BYTES,
    signal,
  };
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > TIMEOUT_MS
  )
    throw new Error('invalid Paperclip CLI timeout');
  if (
    !Number.isSafeInteger(options.maxOutputBytes) ||
    options.maxOutputBytes < 1 ||
    options.maxOutputBytes > MAX_OUTPUT_BYTES
  )
    throw new Error('invalid Paperclip CLI output limit');
  const resolvedIds = new Map<string, string>();
  const activeCalls = new Set<Promise<unknown>>();
  function invoke(
    args: readonly string[],
    requestSignal?: AbortSignal,
    cancelOnStop = true,
  ): Promise<unknown> {
    const signals = [
      ...(cancelOnStop ? [options.signal] : []),
      ...(requestSignal ? [requestSignal] : []),
    ];
    const effectiveSignal =
      signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const runOptions: {
      executable: string;
      timeoutMs: number;
      maxOutputBytes: number;
      signal?: AbortSignal;
    } = {
      executable: options.executable,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    };
    if (effectiveSignal) runOptions.signal = effectiveSignal;
    const pending = runPaperclip(args, runOptions);
    activeCalls.add(pending);
    return pending.then(
      (value) => {
        activeCalls.delete(pending);
        return value;
      },
      (error: unknown) => {
        activeCalls.delete(pending);
        throw error;
      },
    );
  }
  return {
    async cancelAll() {
      stopController.abort();
      await Promise.allSettled([...activeCalls]);
    },
    async readIssue(issueId, signal) {
      validIssueId(issueId);
      const value = await invoke(['issue', 'get', issueId, '--json'], signal);
      const normalized = normalizeIssueIdentifier(issueId, value);
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return normalized;
      const issue = value as Record<string, unknown>;
      if (typeof issue.id === 'string') {
        resolvedIds.set(issueId, issue.id);
      }
      return normalized;
    },
    async readActivity(issueId, signal) {
      validIssueId(issueId);
      const value = await invoke(
        ['activity', 'issue', issueId, '--json'],
        signal,
      );
      const resolvedId = resolvedIds.get(issueId);
      if (!resolvedId || !Array.isArray(value)) return value;
      return value.map((event: unknown) => {
        if (
          typeof event === 'object' &&
          event !== null &&
          'entityId' in event &&
          event.entityId === resolvedId
        )
          return { ...event, entityId: issueId };
        return event;
      });
    },
    async readComments(issueId, signal) {
      validIssueId(issueId);
      return invoke(
        ['issue', 'comments', issueId, '--limit', '500', '--json'],
        signal,
      );
    },
    async updateIssue(issueId, status, comment) {
      validIssueId(issueId);
      if (!status || /[\r\n]/.test(status))
        throw new Error('invalid Paperclip issue status');
      const resolvedId = resolvedIds.get(issueId) ?? issueId;
      const receipt = await invoke(
        [
          'issue',
          'update',
          resolvedId,
          '--status',
          status,
          '--comment',
          comment,
          '--json',
        ],
        undefined,
        false,
      );
      return normalizeIssueIdentifier(issueId, receipt);
    },
  };
}
