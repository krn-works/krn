import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { copyFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  addWorktree,
  fixtureRepo,
  git,
  readyIds,
  removeWorktree,
  runCli,
  runCliAsync,
  task,
  useScratch,
} from './claims-fixture.ts';

useScratch();

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
      Array.from({ length: 20 }, async (_, index) => {
        const actor = `worker-${index}`;
        const worktree = index % 2 === 0 ? first : second;
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
    const winners = attempts.filter((result) => result.status === 0);
    const ids = winners.map((result) => result.stdout.trim());
    assert.equal(new Set(ids).size, ids.length, 'no task may be claimed twice');
    assert.ok(winners.length > 0, 'at least one ready task must be claimed');
    assert.ok(
      winners.length <= records.length,
      'winners cannot exceed ready tasks',
    );
    for (const result of attempts) {
      if (result.status !== 0) {
        assert.equal(result.status, 75, result.stderr);
        assert.match(
          result.stderr,
          /task claim is busy|no ready tasks are available to claim/u,
        );
        assert.equal(result.stdout.trim(), '');
        continue;
      }
      const id = result.stdout.trim();
      assert.ok(
        records.some((record) => record.id === id),
        'winner must claim a ready task',
      );
      const saved = JSON.parse(
        readFileSync(join(repo, '.krn', 'task-claims', `${id}.json`), 'utf8'),
      );
      assert.equal(saved.id, id);
      assert.equal(
        saved.actor,
        result.actor,
        'claim must belong to its reported winner',
      );
      assert.equal(saved.worktree, realpathSync(result.worktree));
      assert.equal(
        saved.branch,
        result.worktree === first
          ? 'claim-concurrent-first-branch'
          : 'claim-concurrent-second-branch',
      );
    }
    assert.deepEqual(
      (await readdir(join(repo, '.krn', 'task-claims')))
        .filter((name) => name.endsWith('.json'))
        .sort(),
      ids.map((id) => `${id}.json`).sort(),
      'every persisted claim must have exactly one successful owner',
    );
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
    const claim = await runCli(linked, ['claim', 'T-1', '--actor', 'worker']);
    assert.equal(claim.status, 0, claim.stderr);
    git(repo, 'worktree', 'remove', '--force', linked);
    const show = JSON.parse(
      (await runCli(repo, ['show', 'T-1', '--json'])).stdout,
    );
    assert.equal(show.claim.state, 'expired');
    assert.equal(show.claim.reason, 'expired: worktree path is missing');
    assert.match(
      (await runCli(repo, ['show', 'T-1'])).stdout,
      /Claim: expired: worktree path is missing/u,
    );
    assert.deepEqual(readyIds(await runCli(repo, ['ready', '--json'])), [
      'T-1',
    ]);
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
    const claim = await runCli(linked, ['claim', 'T-1', '--actor', 'worker']);
    assert.equal(claim.status, 0, claim.stderr);
    git(linked, 'switch', '--quiet', '--detach', 'HEAD');
    git(repo, 'branch', '-D', 'claim-branch-deleted-branch');
    assert.equal(
      JSON.parse((await runCli(repo, ['show', 'T-1', '--json'])).stdout).claim
        .state,
      'expired',
    );
    assert.equal(
      JSON.parse((await runCli(repo, ['show', 'T-1', '--json'])).stdout).claim
        .reason,
      'expired: branch claim-branch-deleted-branch does not exist',
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
      (await runCli(linked, ['claim', 'T-1', '--actor', 'worker'])).status,
      0,
    );
    const closed = await runCli(linked, ['close', 'T-1', '--as', 'done']);
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(
      JSON.parse((await runCli(repo, ['show', 'T-1', '--json'])).stdout).claim
        .state,
      'expired',
    );
    assert.equal(
      JSON.parse((await runCli(repo, ['show', 'T-1', '--json'])).stdout).claim
        .reason,
      'expired: task is closed in worktree',
    );
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});

test('deleting the task file from the claiming worktree expires its claim', async () => {
  const repo = await fixtureRepo('claim-local-missing-', [task('T-1')]);
  const linked = join(dirname(repo), 'claim-local-missing-linked');
  try {
    addWorktree(repo, linked, 'claim-local-missing-branch');
    assert.equal(
      (await runCli(linked, ['claim', 'T-1', '--actor', 'worker'])).status,
      0,
    );
    await rm(join(linked, 'tasks', 'T-1.json'));
    const show = await runCli(repo, ['show', 'T-1', '--json']);
    assert.equal(show.status, 0, show.stderr);
    assert.equal(JSON.parse(show.stdout).claim.state, 'expired');
    assert.equal(
      JSON.parse(show.stdout).claim.reason,
      'expired: task file is missing from worktree',
    );
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
      (await runCli(linked, ['claim', 'T-1', '--actor', 'worker'])).status,
      0,
    );
    // The live claim routes the close into the lane; the merge brings it to main.
    const closed = await runCli(repo, ['close', 'T-1', '--as', 'done']);
    assert.equal(closed.status, 0, closed.stderr);
    await copyFile(
      join(linked, 'tasks', 'T-1.json'),
      join(repo, 'tasks', 'T-1.json'),
    );
    git(linked, 'checkout', '--', 'tasks/T-1.json');
    git(repo, 'add', 'tasks/T-1.json');
    git(repo, 'commit', '-qm', 'close task on origin main');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const show = JSON.parse(
      (await runCli(linked, ['show', 'T-1', '--json'])).stdout,
    );
    assert.equal(show.claim.state, 'expired');
    assert.equal(show.claim.reason, 'expired: task is closed in origin/main');
  } finally {
    removeWorktree(repo, linked);
    await rm(repo, { recursive: true, force: true });
  }
});
