import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  ClaimGitProbe,
  ClaimLivenessProbes,
  TaskClaim,
} from '../../src/task/claims.ts';
import {
  serializeTask,
  type TaskId,
  type TaskRecord,
} from '../../src/task/record.ts';

export const cli = fileURLToPath(
  new URL('../../src/cli/main.ts', import.meta.url),
);
export let scratch: string;
export function useScratch(): void {
  beforeEach(async (t) => {
    assert.ok('after' in t, 'private task fixtures require a test context');
    const ownedScratch = await mkdtemp(join(tmpdir(), 'krn-task-claims-'));
    scratch = ownedScratch;
    t.after(() => rm(ownedScratch, { recursive: true, force: true }));
  });
}

export function livenessClaim(): TaskClaim {
  return {
    id: 'T-1' as TaskId,
    actor: 'worker',
    worktree: process.cwd(),
    branch: 'worker',
    claimed: '2026-10-26T00:00:00.000Z',
    reason: null,
  };
}

export function baseLivenessProbes(): ClaimLivenessProbes {
  const openTask = Buffer.from(serializeTask(task('T-1')));
  return {
    resolveWorktree: () => process.cwd(),
    worktreeList: () => gitProbe(0, Buffer.from(`worktree ${process.cwd()}\0`)),
    branchRef: () => gitProbe(0),
    taskFile: () => openTask,
    originRef: () => gitProbe(0),
    originTask: () => gitProbe(0, openTask),
  };
}

export function gitProbe(
  status: number | null,
  stdout = Buffer.alloc(0),
  error?: Error,
): ClaimGitProbe {
  return {
    status,
    ...(error === undefined ? {} : { error }),
    stdout,
  };
}

export function codedError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

export async function tempRepo(prefix: string): Promise<string> {
  await mkdir(scratch, { recursive: true });
  const repo = await mkdtemp(join(scratch, prefix));
  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'KRN task claim test');
  git(repo, 'config', 'user.email', 'krn-task-claim-test@example.invalid');
  await writeFile(join(repo, 'README.md'), 'Task fixture\n');
  await writeFile(join(repo, '.gitignore'), '.krn/\n');
  git(repo, 'add', 'README.md', '.gitignore');
  git(repo, 'commit', '-qm', 'initialize task fixture');
  return repo;
}

export async function fixtureRepo(
  prefix: string,
  records: TaskRecord[],
): Promise<string> {
  const repo = await tempRepo(prefix);
  const directory = join(repo, 'tasks');
  await mkdir(directory, { recursive: true });
  for (const record of records)
    await writeFile(
      join(directory, `${record.id}.json`),
      serializeTask(record),
    );
  git(repo, 'add', 'tasks');
  git(repo, 'commit', '-qm', 'add task fixtures');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return repo;
}

export function task(
  id: string,
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    id,
    status: 'open',
    resolution: null,
    created: '2026-10-26',
    priority: 2,
    title: `Task ${id}`,
    after: [],
    body: [],
    ...overrides,
  };
}

export function readyIds(result: CliResult): string[] {
  assert.equal(result.status, 0, result.stderr);
  return (JSON.parse(result.stdout).tasks as TaskRecord[]).map(
    (record) => record.id,
  );
}

export function addWorktree(root: string, path: string, branch: string): void {
  git(root, 'worktree', 'add', '--quiet', '-b', branch, path, 'HEAD');
}

export function removeWorktree(root: string, path: string): void {
  if (!existsSync(path)) return;
  spawnSync('git', ['-C', root, 'worktree', 'remove', '--force', path], {
    encoding: 'utf8',
    env: cleanGitEnvironment(),
    timeout: 10_000,
  });
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// In-process by default: the CLI entry point is `taskCommand`, so calling it
// avoids a node boot per assertion. Tests that prove the receiver boundary
// pass `{ spawn: true }` to run the real binary.
export async function runCli(
  cwd: string,
  args: string[],
  options?: { spawn: true },
): Promise<CliResult> {
  return options?.spawn ? runCliSpawn(cwd, args) : runCliInProcess(cwd, args);
}

export async function runCliInProcess(
  cwd: string,
  args: string[],
): Promise<CliResult> {
  const { taskCommand } = await import('../../src/task/cli.ts');
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const originalExitCode = process.exitCode;
  let stdout = '';
  let stderr = '';
  for (const key of Object.keys(process.env))
    if (key.startsWith('GIT_')) delete process.env[key];
  process.env.KRN_HOOK_NOGIT_TMPDIR ??= scratch;
  process.exitCode = undefined;
  process.chdir(cwd);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await taskCommand(args);
    return { status: Number(process.exitCode ?? 0), stdout, stderr };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    process.exitCode = originalExitCode;
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
}

export function runCliSpawn(cwd: string, args: string[]): CliResult {
  const result = spawnSync(process.execPath, [cli, 'task', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...cleanGitEnvironment(),
      KRN_HOOK_NOGIT_TMPDIR: process.env.KRN_HOOK_NOGIT_TMPDIR ?? scratch,
    },
    timeout: 10_000,
  });
  return {
    status: result.status,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

export function runCliAsync(cwd: string, args: string[]): Promise<CliResult> {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [cli, 'task', ...args], {
      cwd,
      env: {
        ...cleanGitEnvironment(),
        KRN_HOOK_NOGIT_TMPDIR: process.env.KRN_HOOK_NOGIT_TMPDIR ?? scratch,
      },
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
    child.once('close', (status) => resolveResult({ status, stdout, stderr }));
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
