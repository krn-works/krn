import { spawn } from 'node:child_process';
import type { LedgerTransport } from './index.ts';

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

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

function runPaperclip(
  args: readonly string[],
  options: { executable: string; timeoutMs: number; maxOutputBytes: number },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable, [...args], {
      shell: false,
      env: cliEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finishError = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new Error(message));
    };
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
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', () => finishError('Paperclip CLI could not be started'));
    const timer = setTimeout(
      () =>
        finishError(`Paperclip CLI timed out after ${options.timeoutMs} ms`),
      options.timeoutMs,
    );
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

function validIssueId(issueId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(issueId))
    throw new Error('invalid Paperclip issue ID');
}

export function createPaperclipCliTransport(
  configuration: {
    executable?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
  } = {},
): LedgerTransport {
  const options = {
    executable: configuration.executable ?? 'paperclip',
    timeoutMs: configuration.timeoutMs ?? TIMEOUT_MS,
    maxOutputBytes: configuration.maxOutputBytes ?? MAX_OUTPUT_BYTES,
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
  return {
    async readIssue(issueId) {
      validIssueId(issueId);
      const value = await runPaperclip(
        ['issue', 'get', issueId, '--json'],
        options,
      );
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return value;
      const issue = value as Record<string, unknown>;
      if (typeof issue.id === 'string') {
        resolvedIds.set(issueId, issue.id);
        if (issue.identifier === issueId) return { ...issue, id: issueId };
      }
      return value;
    },
    async readActivity(issueId) {
      validIssueId(issueId);
      const value = await runPaperclip(
        ['activity', 'issue', issueId, '--json'],
        options,
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
    async updateIssue(issueId, status, comment) {
      validIssueId(issueId);
      if (!status || /[\r\n]/.test(status))
        throw new Error('invalid Paperclip issue status');
      const resolvedId = resolvedIds.get(issueId) ?? issueId;
      return runPaperclip(
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
        options,
      );
    },
  };
}
