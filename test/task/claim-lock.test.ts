import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  claimTask,
  inspectClaim,
  releaseClaim,
  serializeClaim,
} from '../../src/task/claims.ts';
import { serializeTask, type TaskRecord } from '../../src/task/record.ts';

const cli = fileURLToPath(new URL('../../src/cli/krn.mjs', import.meta.url));

test('expired claims have one concurrent claim --next winner across two worktrees', {
  timeout: 180_000,
}, async () => {
  const repo = await fixtureRepo('claim-lock-race-', [task('T-1')]);
  const linked = join(dirname(repo), `${basename(repo)}-linked`);
  try {
    addWorktree(repo, linked, 'claim-lock-race-linked-branch');
    const claimPath = join(repo, '.krn', 'task-claims', 'T-1.json');

    for (let trial = 0; trial < 20; trial += 1) {
      await mkdir(dirname(claimPath), { recursive: true });
      await writeFile(
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

      const results = await Promise.all(
        Array.from({ length: 12 }, async (_, index) => {
          const actor = `worker-${trial}-${index}`;
          const worktree = index % 2 === 0 ? repo : linked;
          return {
            actor,
            worktree,
            ...(await runCliAsync(worktree, [
              'claim',
              '--next',
              '--actor',
              actor,
            ])),
          };
        }),
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
      assert.equal(saved.worktree, realPath(winner.worktree));
    }
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});

test('takeover, release, and plain claim mutations stay serialized', async () => {
  const ids = Array.from({ length: 10 }, (_, index) => `T-${index + 1}`);
  const repo = await fixtureRepo('claim-lock-mutations-', ids.map(task));
  const linked = join(dirname(repo), `${basename(repo)}-linked`);
  try {
    addWorktree(repo, linked, 'claim-lock-mutations-linked-branch');
    for (const id of ids) await claimTask(repo, id, { actor: `seed-${id}` });

    await Promise.all(
      ids.map(async (id, trial) => {
        const results = await Promise.all(
          Array.from({ length: 18 }, async (_, index) => {
            const kind =
              index < 6 ? 'takeover' : index < 12 ? 'release' : 'claim';
            const actor = `${kind}-${trial}-${index}`;
            const worktree = index % 2 === 0 ? repo : linked;
            try {
              if (kind === 'release') await releaseClaim(worktree, id);
              else
                await claimTask(worktree, id, {
                  actor,
                  ...(kind === 'takeover'
                    ? { takeover: true, reason: 'reassigning work' }
                    : {}),
                });
              return { kind, code: 0 };
            } catch (error) {
              return { kind, code: errorCode(error) };
            }
          }),
        );

        assert.ok(results.every(({ code }) => [0, 65, 75].includes(code)));
        const takeovers = results.filter(({ kind }) => kind === 'takeover');
        assert.ok(takeovers.some(({ code }) => code === 0));
        assert.ok(takeovers.every(({ code }) => code === 0 || code === 75));
        assert.ok(['live', 'none'].includes(inspectClaim(repo, id).state));
      }),
    );
    assert.equal(existsSync(join(repo, '.krn', 'tmp', 'task-locks')), false);
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});

test('a killed lock holder releases the task name to the next claimer', {
  timeout: 15_000,
}, async () => {
  const repo = await fixtureRepo('claim-lock-killed-', [task('T-1')]);
  let holder: ReturnType<typeof startLockHolder> | undefined;
  try {
    holder = startLockHolder(repo, 'T-1');
    await holder.locked;
    const closed = waitForClose(holder.child);
    holder.child.kill('SIGKILL');
    const result = await closed;
    assert.equal(result.signal, 'SIGKILL');

    const claimed = await runCliAsync(repo, [
      'claim',
      'T-1',
      '--actor',
      'after-kill',
    ]);
    assert.equal(claimed.status, 0, claimed.stderr);
    assert.match(claimed.stdout, /T-1/u);
  } finally {
    await stopHolder(holder);
    await rm(repo, { recursive: true, force: true });
  }
});

test('a live lock holder makes a contender return claim busy', {
  timeout: 15_000,
}, async () => {
  const repo = await fixtureRepo('claim-lock-live-', [task('T-1')]);
  let holder: ReturnType<typeof startLockHolder> | undefined;
  try {
    holder = startLockHolder(repo, 'T-1');
    await holder.locked;

    const contender = await runCliAsync(repo, [
      'claim',
      'T-1',
      '--actor',
      'blocked',
    ]);
    assert.equal(contender.status, 75, contender.stderr);
    assert.match(contender.stderr, /claim is busy/u);
  } finally {
    await stopHolder(holder);
    await rm(repo, { recursive: true, force: true });
  }
});

test('repositories with the same task id have separate lock names', {
  timeout: 10_000,
}, async () => {
  const first = await fixtureRepo('claim-lock-repository-first-', [
    task('T-1'),
  ]);
  const second = await fixtureRepo('claim-lock-repository-second-', [
    task('T-1'),
  ]);
  let holder: ReturnType<typeof startLockHolder> | undefined;
  try {
    holder = startLockHolder(first, 'T-1');
    await holder.locked;

    const independent = await runCliAsync(second, [
      'claim',
      'T-1',
      '--actor',
      'independent',
    ]);
    assert.equal(independent.status, 0, independent.stderr);
    assert.equal(inspectClaim(second, 'T-1').state, 'live');
  } finally {
    await stopHolder(holder);
    await Promise.all([
      rm(first, { recursive: true, force: true }),
      rm(second, { recursive: true, force: true }),
    ]);
  }
});

test('a 100-character task id can be claimed and released', async () => {
  const id = `T-${'1'.repeat(98)}`;
  const repo = await fixtureRepo('claim-lock-long-id-', [task(id)]);
  try {
    await claimTask(repo, id, { actor: 'worker' });
    assert.equal(inspectClaim(repo, id).state, 'live');

    await releaseClaim(repo, id);
    assert.equal(inspectClaim(repo, id).state, 'none');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('long task ids with the same prefix have separate lock names', {
  timeout: 10_000,
}, async () => {
  const prefix = `T-${'a'.repeat(97)}`;
  const firstId = `${prefix}1`;
  const secondId = `${prefix}2`;
  const repo = await fixtureRepo('claim-lock-long-prefix-', [
    task(firstId),
    task(secondId),
  ]);
  let holder: ReturnType<typeof startLockHolder> | undefined;
  try {
    holder = startLockHolder(repo, firstId);
    await holder.locked;

    const independent = await runCliAsync(repo, [
      'claim',
      secondId,
      '--actor',
      'independent',
    ]);
    assert.equal(independent.status, 0, independent.stderr);
    assert.equal(inspectClaim(repo, secondId).state, 'live');
  } finally {
    await stopHolder(holder);
    await rm(repo, { recursive: true, force: true });
  }
});

function startLockHolder(root: string, id: string) {
  const child = spawn(
    process.execPath,
    [cli, 'task', 'claim', id, '--actor', 'holder'],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        KRN_TASK_LOCK_HOLD_FD: '3',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    },
  );
  const signal = child.stdio[3] as Readable | null;
  assert.ok(signal, 'test holder signal pipe is missing');
  const locked = waitForSignal(child, signal);
  return { child, locked };
}

function waitForSignal(child: ReturnType<typeof spawn>, stream: Readable) {
  return new Promise<void>((resolve, reject) => {
    let buffered = '';
    const timeout = setTimeout(
      () => finish(new Error('lock signal timed out')),
      5_000,
    );
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      if (buffered.includes('locked\n')) finish();
    };
    const onClose = () =>
      finish(new Error('lock holder exited before acquiring the task lock'));
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      stream.removeListener('data', onData);
      child.removeListener('close', onClose);
      if (error) reject(error);
      else resolve();
    };
    stream.on('data', onData);
    child.once('close', onClose);
  });
}

function waitForClose(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    },
  );
}

async function stopHolder(
  holder: ReturnType<typeof startLockHolder> | undefined,
): Promise<void> {
  if (holder === undefined) return;
  if (holder.child.exitCode !== null || holder.child.signalCode !== null)
    return;
  const closed = waitForClose(holder.child);
  holder.child.kill('SIGKILL');
  await closed;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCliAsync(root: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'task', ...args], {
      cwd: root,
      env: process.env,
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
  const repo = await mkdtemp(join(tmpdir(), prefix));
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

function realPath(path: string): string {
  return git(path, 'rev-parse', '--show-toplevel');
}

function errorCode(error: unknown): number {
  if (
    error instanceof Error &&
    'exitCode' in error &&
    typeof error.exitCode === 'number'
  )
    return error.exitCode;
  throw error;
}
