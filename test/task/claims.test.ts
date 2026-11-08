import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  addWorktree,
  fixtureRepo,
  git,
  readyIds,
  removeWorktree,
  runCli,
  task,
  tempRepo,
  useScratch,
} from './claims-fixture.ts';

useScratch();

test('claim --next claims a ready task and ready omits it', async () => {
  const repo = await tempRepo('claim-ready-');
  try {
    const created = await runCli(
      repo,
      ['create', '--title', 'Claimable task'],
      { spawn: true },
    );
    assert.equal(created.status, 0, created.stderr);
    const id = created.stdout.trim();

    const claimed = await runCli(
      repo,
      ['claim', '--next', '--actor', 'worker'],
      { spawn: true },
    );
    assert.equal(claimed.status, 0, claimed.stderr);
    assert.equal(claimed.stdout.trim(), id);

    const ready = await runCli(repo, ['ready', '--json'], { spawn: true });
    assert.equal(ready.status, 0, ready.stderr);
    assert.deepEqual(JSON.parse(ready.stdout).tasks, []);
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
    assert.deepEqual(readyIds(await runCli(repo, ['ready', '--json'])), [
      'T-2',
    ]);
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
    assert.deepEqual(readyIds(await runCli(repo, ['ready', '--json'])), [
      'T-1',
    ]);
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
    assert.deepEqual(readyIds(await runCli(repo, ['ready', '--json'])), [
      'T-1',
    ]);
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
    assert.deepEqual(readyIds(await runCli(repo, ['ready', '--json'])), [
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
      readyIds(await runCli(repo, ['ready', '--json', '--limit', '2'])),
      ['T-1', 'T-2'],
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ready excludes live claims and show reports the claim', async () => {
  const repo = await fixtureRepo('ready-claimed-', [task('T-1'), task('T-2')]);
  try {
    const claim = await runCli(repo, ['claim', 'T-1', '--actor', 'worker']);
    assert.equal(claim.status, 0, claim.stderr);
    const held = await runCli(repo, ['claim', 'T-1', '--actor', 'second']);
    assert.equal(held.status, 75);
    assert.match(held.stderr, /actor worker/u);
    assert.match(held.stderr, /worktree .+ready-claimed-/u);
    assert.match(held.stderr, /branch main/u);
    assert.deepEqual(readyIds(await runCli(repo, ['ready', '--json'])), [
      'T-2',
    ]);
    const show = await runCli(repo, ['show', 'T-1', '--json'], {
      spawn: true,
    });
    assert.equal(show.status, 0, show.stderr);
    assert.equal(JSON.parse(show.stdout).claim.state, 'live');
    assert.equal(JSON.parse(show.stdout).claim.reason, 'live');
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
    const claim = await runCli(linked, ['claim', 'T-1', '--actor', 'worker']);
    assert.equal(claim.status, 0, claim.stderr);
    const claimFile = join(repo, '.krn', 'task-claims', 'T-1.json');
    const before = readFileSync(claimFile);
    git(repo, 'worktree', 'remove', '--force', linked);

    assert.deepEqual(readyIds(await runCli(repo, ['ready', '--json'])), [
      'T-1',
    ]);
    assert.deepEqual(readFileSync(claimFile), before);
    assert.equal(
      JSON.parse((await runCli(repo, ['show', 'T-1', '--json'])).stdout).claim
        .state,
      'expired',
    );
    assert.equal(
      JSON.parse((await runCli(repo, ['show', 'T-1', '--json'])).stdout).claim
        .reason,
      'expired: worktree path is missing',
    );
    assert.equal(
      (await runCli(repo, ['release', 'T-1'], { spawn: true })).status,
      0,
    );
    assert.equal(existsSync(claimFile), false);
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});

test('ready removes claims of tasks closed in the main checkout', async () => {
  const repo = await fixtureRepo('ready-closed-', [task('T-1'), task('T-2')]);
  const linked = join(dirname(repo), 'ready-closed-linked');
  try {
    addWorktree(repo, linked, 'ready-closed-branch');
    assert.equal(
      (await runCli(linked, ['claim', 'T-1', '--actor', 'lead'])).status,
      0,
    );
    assert.equal(
      (await runCli(repo, ['claim', 'T-2', '--actor', 'lead'])).status,
      0,
    );
    const closed = await runCli(linked, ['close', 'T-1', '--as', 'done']);
    assert.equal(closed.status, 0, closed.stderr);
    git(linked, 'commit', '-qam', 'close T-1');
    const claims = join(repo, '.krn', 'task-claims');
    // Closed only in the delivery branch: the claim still holds.
    await runCli(repo, ['ready', '--json']);
    assert.ok(existsSync(join(claims, 'T-1.json')));
    git(repo, 'merge', '-q', 'ready-closed-branch');
    assert.deepEqual(readyIds(await runCli(repo, ['ready', '--json'])), []);
    assert.equal(existsSync(join(claims, 'T-1.json')), false);
    assert.ok(existsSync(join(claims, 'T-2.json')));
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
    const claim = await runCli(linked, ['claim', 'T-1', '--actor', 'worker']);
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
    const created = await runCli(linked, [
      'create',
      '--title',
      'Linked-only task',
    ]);
    assert.equal(created.status, 0, created.stderr);
    const id = created.stdout.trim();
    const claimed = await runCli(repo, [
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
      JSON.parse((await runCli(linked, ['show', id, '--json'])).stdout).claim
        .state,
      'live',
    );
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});
