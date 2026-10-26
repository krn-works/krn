import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { serializeClaim } from '../../src/task/claims.ts';
import { serializeTask, type TaskRecord } from '../../src/task/record.ts';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const scratch = join(process.cwd(), '.krn/runs/claude-claim-lock/scratch');

test('expired claims have one concurrent claim --next winner across two worktrees for twenty trials', {
  timeout: 120_000,
}, async () => {
  const repo = await fixtureRepo('claim-lock-race-', [task('T-1')]);
  const linked = join(dirname(repo), 'claim-lock-race-linked');
  try {
    addWorktree(repo, linked, 'claim-lock-race-linked-branch');
    const claimPath = join(repo, '.krn', 'task-claims', 'T-1.json');

    for (let trial = 0; trial < 20; trial += 1) {
      mkdirSync(dirname(claimPath), { recursive: true });
      writeFileSync(
        claimPath,
        serializeClaim({
          id: 'T-1',
          actor: `stale-${trial}`,
          worktree: join(dirname(repo), `missing-worktree-${trial}`),
          branch: `missing-branch-${trial}`,
          claimed: '2026-10-26T00:00:00.000Z',
          reason: null,
        }),
      );

      const contenders = Array.from({ length: 12 }, (_, index) => {
        const actor = `worker-${trial}-${index}`;
        const worktree = index % 2 === 0 ? repo : linked;
        return {
          actor,
          worktree,
          result: runCliAsync(worktree, ['claim', '--next', '--actor', actor]),
        };
      });
      const results = await Promise.all(
        contenders.map(async ({ actor, worktree, result }) => ({
          actor,
          worktree,
          ...(await result),
        })),
      );
      const winners = results.filter((result) => result.status === 0);
      assert.equal(
        winners.length,
        1,
        `trial ${trial}: ${results.map((result) => `${result.actor}=${result.status}`).join(', ')}`,
      );
      assert.equal(results.filter((result) => result.status === 75).length, 11);

      const winner = winners[0];
      assert.ok(winner);
      assert.equal(winner.stdout.trim(), 'T-1');
      const saved = JSON.parse(readFileSync(claimPath, 'utf8')) as {
        actor: string;
        id: string;
        worktree: string;
      };
      assert.equal(saved.id, 'T-1');
      assert.equal(saved.actor, winner.actor);
      assert.equal(saved.worktree, realpathSync(winner.worktree));
    }
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});

test('claiming recovers a stale per-task lock with a dead local pid', async () => {
  const repo = await fixtureRepo('claim-lock-stale-', [task('T-1')]);
  const lockPath = join(repo, '.krn', 'tmp', 'task-locks', 'T-1.lock');
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: deadPid(),
        hostname: hostname(),
        acquired: '2026-10-26T00:00:00.000Z',
      })}\n`,
    );

    const claimed = runCli(repo, ['claim', '--next', '--actor', 'recovered']);
    assert.equal(claimed.status, 0, claimed.stderr);
    assert.equal(claimed.stdout.trim(), 'T-1');
    assert.equal(existsSync(lockPath), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('claiming reports busy when another live local pid holds the lock', async () => {
  const repo = await fixtureRepo('claim-lock-live-', [task('T-1')]);
  const lockPath = join(repo, '.krn', 'tmp', 'task-locks', 'T-1.lock');
  const heldLock = `${JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    acquired: '2026-10-26T00:00:00.000Z',
  })}\n`;
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, heldLock);

    const claimed = runCli(repo, ['claim', '--next', '--actor', 'blocked']);
    assert.equal(claimed.status, 75, claimed.stderr);
    assert.match(claimed.stderr, /claim is busy/u);
    assert.equal(readFileSync(lockPath, 'utf8'), heldLock);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(root: string, args: string[]): CliResult {
  const result = spawnSync(process.execPath, [cli, 'task', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runCliAsync(root: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'task', ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (status) =>
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });
}

async function fixtureRepo(
  prefix: string,
  records: TaskRecord[],
): Promise<string> {
  const repo = await tempRepo(prefix);
  await mkdir(join(repo, 'tasks'), { recursive: true });
  for (const record of records)
    await writeFile(
      join(repo, 'tasks', `${record.id}.json`),
      serializeTask(record),
    );
  git(repo, 'add', 'tasks');
  git(repo, 'commit', '-qm', 'add task fixtures');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return repo;
}

async function tempRepo(prefix: string): Promise<string> {
  await mkdir(scratch, { recursive: true });
  const repo = await mkdtemp(join(scratch, prefix));
  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'KRN task claim lock test');
  git(repo, 'config', 'user.email', 'krn-task-claim-lock-test@example.invalid');
  await writeFile(join(repo, 'README.md'), 'Task fixture\n');
  await writeFile(join(repo, '.gitignore'), '.krn/\n');
  git(repo, 'add', 'README.md', '.gitignore');
  git(repo, 'commit', '-qm', 'initialize task fixture');
  return repo;
}

function task(id: string): TaskRecord {
  return {
    id,
    status: 'open',
    resolution: null,
    created: '2026-10-26',
    priority: 2,
    title: `Task ${id}`,
    after: [],
    body: [],
  };
}

function addWorktree(root: string, path: string, branch: string): void {
  git(root, 'worktree', 'add', '--quiet', '-b', branch, path, 'HEAD');
}

function removeWorktree(root: string, path: string): void {
  if (!existsSync(path)) return;
  spawnSync('git', ['-C', root, 'worktree', 'remove', '--force', path], {
    encoding: 'utf8',
  });
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function deadPid(): number {
  const pid = 2_147_483_647;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ESRCH'
    )
      return pid;
    throw error;
  }
  throw new Error('expected test pid to be absent');
}
