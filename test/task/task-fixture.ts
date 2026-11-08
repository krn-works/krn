import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { serializeTask, type TaskRecord } from '../../src/task/record.ts';

export const cli = fileURLToPath(
  new URL('../../src/cli/main.ts', import.meta.url),
);
export let scratch: string;
export function useScratch(): void {
  beforeEach(async (t) => {
    assert.ok('after' in t, 'private task fixtures require a test context');
    const ownedScratch = await mkdtemp(join(tmpdir(), 'krn-task-'));
    scratch = ownedScratch;
    t.after(() => rm(ownedScratch, { recursive: true, force: true }));
  });
}

export const validTask: TaskRecord = {
  id: 'T-1',
  status: 'open',
  resolution: null,
  created: '2026-10-25',
  priority: 2,
  title: 'Valid task',
  after: [],
  body: [],
};

export function rawTask(overrides: Partial<TaskRecord>): string {
  return `${JSON.stringify({ ...validTask, ...overrides }, null, 2)}\n`;
}

export async function tempRepo(prefix: string): Promise<string> {
  const directory = await tempDirectory(prefix);
  await initRepo(directory);
  return directory;
}

export async function tempDirectory(prefix: string): Promise<string> {
  await mkdir(scratch, { recursive: true });
  return mkdtemp(join(scratch, prefix));
}

export async function initRepo(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  git(directory, 'init', '--quiet', '--initial-branch=main');
  git(directory, 'config', 'user.name', 'KRN task test');
  git(directory, 'config', 'user.email', 'krn-task-test@example.invalid');
  await writeFile(join(directory, 'README.md'), 'Task fixture\n');
  git(directory, 'add', 'README.md');
  git(directory, 'commit', '-qm', 'initialize task fixture');
}

export async function writeTask(
  root: string,
  record: TaskRecord,
): Promise<void> {
  const directory = join(root, 'tasks');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${record.id}.json`), serializeTask(record));
}

export function runCli(
  cwd: string,
  args: string[],
  legacy?: string,
  input?: string,
  childEnvironment: NodeJS.ProcessEnv = {},
  timeoutMs = 10_000,
): { status: number | null; stdout: string; stderr: string } {
  const environment = {
    ...cleanGitEnvironment(),
    KRN_HOOK_NOGIT_TMPDIR: process.env.KRN_HOOK_NOGIT_TMPDIR ?? scratch,
    ...(legacy === undefined ? {} : { KRN_LEGACY_ENTRY: legacy }),
    ...childEnvironment,
  };
  const result = spawnSync(process.execPath, [cli, 'task', ...args], {
    cwd,
    encoding: 'utf8',
    env: environment,
    input,
    timeout: timeoutMs,
  });
  return {
    status: result.status,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

export function runCliAsync(
  cwd: string,
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const environment = {
    ...cleanGitEnvironment(),
    KRN_HOOK_NOGIT_TMPDIR: process.env.KRN_HOOK_NOGIT_TMPDIR ?? scratch,
  };
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [cli, 'task', ...args], {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (status) => {
      resolveResult({ status, stdout, stderr });
    });
  });
}

export function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: cleanGitEnvironment(),
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export function cleanGitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
}

export function idSequence(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? ids.at(-1) ?? 't-1234567';
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function dirname(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash < 0 ? '.' : path.slice(0, lastSlash);
}
