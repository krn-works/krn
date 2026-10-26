import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { serializeTask, type TaskRecord } from '../../src/task/record.ts';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const scratch = join(process.cwd(), '.krn/runs/claude-task-claims/scratch');

test('claim --next claims a ready task and ready omits it', async () => {
  const repo = await tempRepo('claim-ready-');
  try {
    const created = runCli(repo, ['create', '--title', 'Claimable task']);
    assert.equal(created.status, 0, created.stderr);
    const id = created.stdout.trim();

    const claimed = runCli(repo, ['claim', '--next', '--actor', 'worker']);
    assert.equal(claimed.status, 0, claimed.stderr);
    assert.equal(claimed.stdout.trim(), id);

    const ready = runCli(repo, ['ready', '--json']);
    assert.equal(ready.status, 0, ready.stderr);
    assert.deepEqual(JSON.parse(ready.stdout), []);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ready unblocks only dependencies closed as done', async () => {
  const repo = await fixtureRepo('ready-resolution-', [
    task('T-1', {
      status: 'closed',
      resolution: { kind: 'done', ref: null, note: '' },
    }),
    task('T-2', { after: ['T-1'] }),
    task('T-3', {
      status: 'closed',
      resolution: { kind: 'dropped', ref: null, note: '' },
    }),
    task('T-4', { after: ['T-3'] }),
    task('T-5', {
      status: 'closed',
      resolution: { kind: 'duplicate', ref: 'T-1', note: '' },
    }),
    task('T-6', { after: ['T-5'] }),
    task('T-7', {
      status: 'closed',
      resolution: { kind: 'superseded', ref: 'T-1', note: '' },
    }),
    task('T-8', { after: ['T-7'] }),
  ]);
  try {
    assert.deepEqual(readyIds(runCli(repo, ['ready', '--json'])), ['T-2']);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ready excludes a task whose dependency remains open', async () => {
  const repo = await fixtureRepo('ready-open-dependency-', [
    task('T-1'),
    task('T-2', { after: ['T-1'] }),
  ]);
  try {
    assert.deepEqual(readyIds(runCli(repo, ['ready', '--json'])), ['T-1']);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ready resolves a three task dependency chain iteratively', async () => {
  const repo = await fixtureRepo('ready-chain-', [
    task('T-1'),
    task('T-2', { after: ['T-1'] }),
    task('T-3', { after: ['T-2'] }),
  ]);
  try {
    assert.deepEqual(readyIds(runCli(repo, ['ready', '--json'])), ['T-1']);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ready orders by priority, created date, and id', async () => {
  const repo = await fixtureRepo('ready-order-', [
    task('T-4', { priority: 1, created: '2026-10-25' }),
    task('T-3', { priority: 0, created: '2026-10-24' }),
    task('T-2', { priority: 0, created: '2026-10-25' }),
    task('T-1', { priority: 0, created: '2026-10-24' }),
  ]);
  try {
    assert.deepEqual(readyIds(runCli(repo, ['ready', '--json'])), [
      'T-1',
      'T-3',
      'T-2',
      'T-4',
    ]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ready applies limit after sorting', async () => {
  const repo = await fixtureRepo('ready-limit-', [
    task('T-3', { priority: 1 }),
    task('T-2', { priority: 0 }),
    task('T-1', { priority: 0 }),
  ]);
  try {
    assert.deepEqual(
      readyIds(runCli(repo, ['ready', '--json', '--limit', '2'])),
      ['T-1', 'T-2'],
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ready excludes live claims and show reports the claim', async () => {
  const repo = await fixtureRepo('ready-claimed-', [task('T-1'), task('T-2')]);
  try {
    const claim = runCli(repo, ['claim', 'T-1', '--actor', 'worker']);
    assert.equal(claim.status, 0, claim.stderr);
    const held = runCli(repo, ['claim', 'T-1', '--actor', 'second']);
    assert.equal(held.status, 75);
    assert.match(held.stderr, /actor worker/u);
    assert.match(held.stderr, /worktree .+ready-claimed-/u);
    assert.match(held.stderr, /branch main/u);
    assert.deepEqual(readyIds(runCli(repo, ['ready', '--json'])), ['T-2']);
    const show = runCli(repo, ['show', 'T-1', '--json']);
    assert.equal(show.status, 0, show.stderr);
    assert.equal(JSON.parse(show.stdout).claim.state, 'live');
    assert.equal(JSON.parse(show.stdout).claim.holder.actor, 'worker');
    assert.equal(git(repo, 'status', '--porcelain'), '');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ready includes expired claims without deleting or rewriting them', async () => {
  const repo = await fixtureRepo('ready-expired-', [task('T-1')]);
  const linked = join(dirname(repo), 'ready-expired-linked');
  try {
    addWorktree(repo, linked, 'ready-expired-branch');
    const claim = runCli(linked, ['claim', 'T-1', '--actor', 'worker']);
    assert.equal(claim.status, 0, claim.stderr);
    const claimFile = join(repo, '.krn', 'task-claims', 'T-1.json');
    const before = readFileSync(claimFile);
    git(repo, 'worktree', 'remove', '--force', linked);

    assert.deepEqual(readyIds(runCli(repo, ['ready', '--json'])), ['T-1']);
    assert.deepEqual(readFileSync(claimFile), before);
    assert.equal(
      JSON.parse(runCli(repo, ['show', 'T-1', '--json']).stdout).claim.state,
      'expired',
    );
    assert.equal(runCli(repo, ['release', 'T-1']).status, 0);
    assert.equal(existsSync(claimFile), false);
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});

test('linked worktree claims land in the main checkout claim store', async () => {
  const repo = await fixtureRepo('claim-linked-store-', [task('T-1')]);
  const linked = join(dirname(repo), 'claim-linked-store-linked');
  try {
    addWorktree(repo, linked, 'claim-linked-store-branch');
    const claim = runCli(linked, ['claim', 'T-1', '--actor', 'worker']);
    assert.equal(claim.status, 0, claim.stderr);
    const path = join(repo, '.krn', 'task-claims', 'T-1.json');
    assert.equal(existsSync(path), true);
    assert.equal(
      existsSync(join(linked, '.krn', 'task-claims', 'T-1.json')),
      false,
    );
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(Object.keys(saved), [
      'id',
      'actor',
      'worktree',
      'branch',
      'claimed',
      'reason',
    ]);
    assert.equal(saved.worktree, realpathSync(linked));
    assert.equal(saved.branch, 'claim-linked-store-branch');
    assert.equal(git(repo, 'status', '--porcelain'), '');
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});

test('claim --next reads readiness from its selected worktree', async () => {
  const repo = await fixtureRepo('claim-next-selected-', [
    task('T-9', {
      status: 'closed',
      resolution: { kind: 'done', ref: null, note: '' },
    }),
  ]);
  const linked = join(dirname(repo), 'claim-next-selected-linked');
  try {
    addWorktree(repo, linked, 'claim-next-selected-branch');
    const created = runCli(linked, ['create', '--title', 'Linked-only task']);
    assert.equal(created.status, 0, created.stderr);
    const id = created.stdout.trim();
    const claimed = runCli(repo, [
      'claim',
      '--next',
      '--actor',
      'worker',
      '--worktree',
      linked,
    ]);
    assert.equal(claimed.status, 0, claimed.stderr);
    assert.equal(claimed.stdout.trim(), id);
    assert.equal(
      JSON.parse(runCli(linked, ['show', id, '--json']).stdout).claim.state,
      'live',
    );
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});

test('two worktrees can claim concurrently without assigning an id twice', async () => {
  const records = Array.from({ length: 10 }, (_, index) =>
    task(`T-${String(index + 1).padStart(2, '0')}`),
  );
  const repo = await fixtureRepo('claim-concurrent-', records);
  const first = join(dirname(repo), 'claim-concurrent-first');
  const second = join(dirname(repo), 'claim-concurrent-second');
  try {
    addWorktree(repo, first, 'claim-concurrent-first-branch');
    addWorktree(repo, second, 'claim-concurrent-second-branch');
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        runCliAsync(index % 2 === 0 ? first : second, [
          'claim',
          '--next',
          '--actor',
          `worker-${index}`,
        ]),
      ),
    );
    for (const result of attempts)
      assert.ok(result.status === 0 || result.status === 75, result.stderr);
    const ids = attempts
      .filter((result) => result.status === 0)
      .map((result) => result.stdout.trim());
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, 10);
    assert.equal(git(repo, 'status', '--porcelain'), '');
  } finally {
    removeWorktree(repo, first);
    removeWorktree(repo, second);
    await rm(repo, { recursive: true, force: true });
  }
});

test('removing a worktree expires its claim and makes the task ready', async () => {
  const repo = await fixtureRepo('claim-worktree-removed-', [task('T-1')]);
  const linked = join(dirname(repo), 'claim-worktree-removed-linked');
  try {
    addWorktree(repo, linked, 'claim-worktree-removed-branch');
    const claim = runCli(linked, ['claim', 'T-1', '--actor', 'worker']);
    assert.equal(claim.status, 0, claim.stderr);
    git(repo, 'worktree', 'remove', '--force', linked);
    assert.equal(
      JSON.parse(runCli(repo, ['show', 'T-1', '--json']).stdout).claim.state,
      'expired',
    );
    assert.deepEqual(readyIds(runCli(repo, ['ready', '--json'])), ['T-1']);
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});

test('deleting a claim branch expires its claim', async () => {
  const repo = await fixtureRepo('claim-branch-deleted-', [task('T-1')]);
  const linked = join(dirname(repo), 'claim-branch-deleted-linked');
  try {
    addWorktree(repo, linked, 'claim-branch-deleted-branch');
    const claim = runCli(linked, ['claim', 'T-1', '--actor', 'worker']);
    assert.equal(claim.status, 0, claim.stderr);
    git(linked, 'switch', '--quiet', '--detach', 'HEAD');
    git(repo, 'branch', '-D', 'claim-branch-deleted-branch');
    assert.equal(
      JSON.parse(runCli(repo, ['show', 'T-1', '--json']).stdout).claim.state,
      'expired',
    );
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});

test('closing the task in its claiming worktree expires the claim', async () => {
  const repo = await fixtureRepo('claim-local-closed-', [task('T-1')]);
  const linked = join(dirname(repo), 'claim-local-closed-linked');
  try {
    addWorktree(repo, linked, 'claim-local-closed-branch');
    assert.equal(
      runCli(linked, ['claim', 'T-1', '--actor', 'worker']).status,
      0,
    );
    const closed = runCli(linked, ['close', 'T-1', '--as', 'done']);
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(
      JSON.parse(runCli(repo, ['show', 'T-1', '--json']).stdout).claim.state,
      'expired',
    );
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});

test('a task absent from the claiming worktree does not expire an open origin claim', async () => {
  const repo = await fixtureRepo('claim-local-missing-', [task('T-1')]);
  const linked = join(dirname(repo), 'claim-local-missing-linked');
  try {
    addWorktree(repo, linked, 'claim-local-missing-branch');
    assert.equal(
      runCli(linked, ['claim', 'T-1', '--actor', 'worker']).status,
      0,
    );
    await rm(join(linked, 'tasks', 'T-1.json'));
    const show = runCli(repo, ['show', 'T-1', '--json']);
    assert.equal(show.status, 0, show.stderr);
    assert.equal(JSON.parse(show.stdout).claim.state, 'live');
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});

test('closing the task on origin main expires the linked worktree claim', async () => {
  const repo = await fixtureRepo('claim-origin-closed-', [task('T-1')]);
  const linked = join(dirname(repo), 'claim-origin-closed-linked');
  try {
    addWorktree(repo, linked, 'claim-origin-closed-branch');
    assert.equal(
      runCli(linked, ['claim', 'T-1', '--actor', 'worker']).status,
      0,
    );
    const closed = runCli(repo, ['close', 'T-1', '--as', 'done']);
    assert.equal(closed.status, 0, closed.stderr);
    git(repo, 'add', 'tasks/T-1.json');
    git(repo, 'commit', '-qm', 'close task on origin main');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.equal(
      JSON.parse(runCli(linked, ['show', 'T-1', '--json']).stdout).claim.state,
      'expired',
    );
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});

test('corrupt claims fail safe, report all findings, and release clears them', async () => {
  const repo = await fixtureRepo('claim-corrupt-', [task('T-1')]);
  try {
    const directory = join(repo, '.krn', 'task-claims');
    await mkdir(directory, { recursive: true });
    const corrupt = {
      actor: 7,
      id: 'T-1',
      worktree: repo,
      branch: 'main',
      claimed: '2026-10-26T00:00:00.000Z',
      reason: false,
    };
    await writeFile(
      join(directory, 'T-1.json'),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(`${JSON.stringify(corrupt, null, 2)}\n`),
      ]),
    );
    const show = runCli(repo, ['show', 'T-1', '--json']);
    assert.equal(show.status, 0, show.stderr);
    assert.equal(JSON.parse(show.stdout).claim.state, 'corrupt');
    assert.deepEqual(JSON.parse(show.stdout).claim.findings, [
      'file starts with a byte order mark',
      'wrong top-level key order',
      '"actor" must be a string',
      '"reason" must be a string or null',
    ]);
    const ready = runCli(repo, ['ready', '--json']);
    assert.deepEqual(JSON.parse(ready.stdout), []);
    assert.match(ready.stderr, /"actor" must be a string/u);
    const release = runCli(repo, ['release', 'T-1']);
    assert.equal(release.status, 0, release.stderr);
    assert.equal(existsSync(join(directory, 'T-1.json')), false);
    assert.equal(git(repo, 'status', '--porcelain'), '');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('claim rejects unknown, closed, and dependency-blocked tasks', async () => {
  const repo = await fixtureRepo('claim-invalid-task-', [
    task('T-1', {
      status: 'closed',
      resolution: { kind: 'done', ref: null, note: '' },
    }),
    task('T-2'),
    task('T-3', { after: ['T-2'] }),
  ]);
  try {
    const unknown = runCli(repo, ['claim', 'T-9', '--actor', 'worker']);
    assert.equal(unknown.status, 65);
    const closed = runCli(repo, ['claim', 'T-1', '--actor', 'worker']);
    assert.equal(closed.status, 65);
    assert.match(closed.stderr, /task is closed/u);
    const blocked = runCli(repo, ['claim', 'T-3', '--actor', 'worker']);
    assert.equal(blocked.status, 65);
    assert.match(blocked.stderr, /blocked by open after task/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('claim refuses detached HEAD and an unregistered worktree path', async () => {
  const repo = await fixtureRepo('claim-worktree-errors-', [task('T-1')]);
  const unregistered = await tempRepo('claim-unregistered-');
  try {
    git(repo, 'switch', '--quiet', '--detach', 'HEAD');
    const detached = runCli(repo, ['claim', 'T-1', '--actor', 'worker']);
    assert.equal(detached.status, 64);
    assert.match(detached.stderr, /detached HEAD/u);

    const attached = await tempRepo('claim-attached-');
    try {
      const invalid = runCli(attached, [
        'claim',
        'T-1',
        '--actor',
        'worker',
        '--worktree',
        unregistered,
      ]);
      assert.equal(invalid.status, 64);
      assert.match(invalid.stderr, /not registered/u);
    } finally {
      await rm(attached, { recursive: true, force: true });
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(unregistered, { recursive: true, force: true });
  }
});

test('takeover requires a reason, reports the previous holder, and release removes it', async () => {
  const repo = await fixtureRepo('claim-takeover-', [task('T-1'), task('T-2')]);
  try {
    assert.equal(runCli(repo, ['claim', 'T-1', '--actor', 'first']).status, 0);
    assert.equal(git(repo, 'status', '--porcelain'), '');
    const withoutReason = runCli(repo, [
      'claim',
      'T-1',
      '--actor',
      'second',
      '--takeover',
    ]);
    assert.equal(withoutReason.status, 64);
    assert.equal(git(repo, 'status', '--porcelain'), '');
    const takeover = runCli(repo, [
      'claim',
      'T-1',
      '--actor',
      'second',
      '--takeover',
      '--reason',
      'reassigning work',
    ]);
    assert.equal(takeover.status, 0, takeover.stderr);
    assert.match(takeover.stdout, /Previous holder: actor first/u);
    const show = JSON.parse(runCli(repo, ['show', 'T-1', '--json']).stdout);
    assert.equal(show.claim.holder.actor, 'second');
    assert.equal(show.claim.holder.reason, 'reassigning work');
    assert.equal(git(repo, 'status', '--porcelain'), '');
    const next = runCli(repo, ['claim', '--next', '--actor', 'next-worker']);
    assert.equal(next.status, 0, next.stderr);
    assert.equal(next.stdout.trim(), 'T-2');
    assert.equal(git(repo, 'status', '--porcelain'), '');
    assert.equal(runCli(repo, ['release', 'T-1']).status, 0);
    assert.equal(git(repo, 'status', '--porcelain'), '');
    assert.equal(runCli(repo, ['release', 'T-2']).status, 0);
    assert.equal(git(repo, 'status', '--porcelain'), '');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('release of a missing claim returns 65', async () => {
  const repo = await fixtureRepo('claim-release-missing-', [task('T-1')]);
  try {
    const show = runCli(repo, ['show', 'T-1', '--json']);
    assert.equal(show.status, 0, show.stderr);
    assert.equal(JSON.parse(show.stdout).claim.state, 'none');
    assert.match(runCli(repo, ['show', 'T-1']).stdout, /Claim: none/u);
    const release = runCli(repo, ['release', 'T-1']);
    assert.equal(release.status, 65);
    assert.match(release.stderr, /no claim to release/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('claim --next returns 75 when no task is ready', async () => {
  const repo = await fixtureRepo('claim-next-empty-', [task('T-1')]);
  try {
    assert.equal(runCli(repo, ['claim', 'T-1', '--actor', 'worker']).status, 0);
    const next = runCli(repo, ['claim', '--next', '--actor', 'next-worker']);
    assert.equal(next.status, 75);
    assert.match(next.stderr, /no ready tasks are available to claim/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('stale task-write files do not affect readiness or claims and claim files stay clean', async () => {
  const repo = await fixtureRepo('claim-stale-stage-', [task('T-1')]);
  try {
    const staging = join(repo, '.krn', 'tmp', 'task-write');
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, '.T-9.stale.tmp'), '{ stale\n');
    assert.deepEqual(readyIds(runCli(repo, ['ready', '--json'])), ['T-1']);
    const claim = runCli(repo, ['claim', '--next', '--actor', 'worker']);
    assert.equal(claim.status, 0, claim.stderr);
    assert.deepEqual(await readdir(join(repo, '.krn', 'task-claims')), [
      'T-1.json',
    ]);
    assert.equal(git(repo, 'status', '--porcelain'), '');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('removing the claim directory frees only the tasks it held', async () => {
  const repo = await fixtureRepo('claim-directory-removed-', [
    task('T-1'),
    task('T-2'),
    task('T-3'),
  ]);
  try {
    assert.equal(runCli(repo, ['claim', 'T-2', '--actor', 'worker']).status, 0);
    assert.deepEqual(readyIds(runCli(repo, ['ready', '--json'])), [
      'T-1',
      'T-3',
    ]);
    await rm(join(repo, '.krn', 'task-claims'), {
      recursive: true,
      force: true,
    });
    assert.deepEqual(readyIds(runCli(repo, ['ready', '--json'])), [
      'T-1',
      'T-2',
      'T-3',
    ]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('claiming after expiry removes and reports the prior claim', async () => {
  const repo = await fixtureRepo('claim-expiry-reclaim-', [task('T-1')]);
  const linked = join(dirname(repo), 'claim-expiry-reclaim-linked');
  try {
    addWorktree(repo, linked, 'claim-expiry-reclaim-branch');
    assert.equal(runCli(linked, ['claim', 'T-1', '--actor', 'old']).status, 0);
    git(linked, 'switch', '--quiet', '--detach', 'HEAD');
    git(repo, 'branch', '-D', 'claim-expiry-reclaim-branch');
    const reclaimed = runCli(repo, ['claim', 'T-1', '--actor', 'new']);
    assert.equal(reclaimed.status, 0, reclaimed.stderr);
    assert.match(reclaimed.stderr, /Expired claim for T-1 was removed/u);
    assert.equal(
      JSON.parse(runCli(repo, ['show', 'T-1', '--json']).stdout).claim.holder
        .actor,
      'new',
    );
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});

async function tempRepo(prefix: string): Promise<string> {
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

async function fixtureRepo(
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

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
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

function readyIds(result: CliResult): string[] {
  assert.equal(result.status, 0, result.stderr);
  return (JSON.parse(result.stdout) as TaskRecord[]).map((record) => record.id);
}

function addWorktree(root: string, path: string, branch: string): void {
  git(root, 'worktree', 'add', '--quiet', '-b', branch, path, 'HEAD');
}

function removeWorktree(root: string, path: string): void {
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

function runCli(cwd: string, args: string[]): CliResult {
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

function runCliAsync(cwd: string, args: string[]): Promise<CliResult> {
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

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: cleanGitEnvironment(),
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
}
