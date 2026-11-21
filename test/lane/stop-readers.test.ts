// Stop finds its lane in the manifest (ADR 0029 step 4): no transcript and no raw claim file is read for a lane
// that has one, and a lane started before manifests keeps today's reads. Real git, real lane start, real ship record.
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { startLane } from '../../src/cli/lane.ts';
import {
  bindAgent,
  listManifests,
  retireLane,
} from '../../src/lane/manifest.ts';
import {
  claimedBranches,
  claimedWorktree,
  laneRecords,
  laneWorktree,
  ownerCheckout,
  recordedShip,
} from '../../src/lane/session.ts';
import { recordShip } from '../../src/repo/ship-record.ts';
import { claimTask, inspectClaim } from '../../src/task/claims.ts';
import { admitLanesOnAnyHost } from '../helpers/lane-host.ts';
import { git, startFixture } from '../helpers/lane-start.ts';

admitLanesOnAnyHost();
const id = 't-abc1234';

async function startOwn(repo: string, slug: string) {
  git(
    repo,
    'worktree',
    'remove',
    '--force',
    join(repo, '.krn', 'worktrees', 'finished'),
  );
  const { path } = await startLane([
    slug,
    '--task',
    id,
    '--actor',
    'lane-x',
    '--root',
    repo,
  ]);
  const manifest = listManifests(repo).find((m) => m.slug === slug);
  assert.ok(manifest);
  // The raw claim is gone: whatever answers below read the manifest.
  rmSync(join(repo, '.krn', 'task-claims', `${id}.json`), { force: true });
  assert.equal(inspectClaim(repo, id).state, 'none');
  return { path, manifest };
}

test('a lane with a manifest is found without its claim file or its transcript', async (t) => {
  const { repo } = startFixture(t);
  const { path, manifest } = await startOwn(repo, 'mine');
  const env = { KRN_LANE_ID: manifest.laneId };
  assert.deepEqual(
    laneRecords(repo, env, undefined).map((r) => [r.branch, r.worktree]),
    [['mine', path]],
  );
  assert.deepEqual(claimedBranches(repo, env, undefined), ['mine']);
  // A shell back in the main checkout is judged at the lane worktree; one inside it keeps its own.
  assert.equal(claimedWorktree(repo, env, undefined), path);
  assert.equal(claimedWorktree(path, {}, undefined), path);
  // Another session names no lane of this repository.
  assert.equal(claimedWorktree(repo, {}, undefined), repo);
  // A subagent bound by agent id finds its worktree with no transcript path in the payload.
  bindAgent(repo, manifest.laneId, 'agent-1');
  const payload = { agent_type: 'krn-lane', agent_id: 'agent-1' };
  assert.equal(laneWorktree(repo, payload, repo), path);
  assert.equal(
    laneWorktree(repo, { agent_type: 'krn-lane', agent_id: 'other' }, repo),
    repo,
  );
  // A worktree that is gone is judged at its owner.
  assert.equal(ownerCheckout(join(repo, '.krn', 'worktrees', 'gone')), repo);
});

test('a lane started, shipped and dropped keeps its ship verdict through the retired manifest', async (t) => {
  const { repo } = startFixture(t);
  const { path, manifest } = await startOwn(repo, 'shipped');
  const env = { KRN_LANE_ID: manifest.laneId };
  writeFileSync(join(path, 'shipped.txt'), 'x');
  git(path, 'add', '.');
  git(path, 'commit', '-qm', 'feat: shipped');
  const head = git(path, 'rev-parse', 'HEAD');
  // Unshipped: the commit is on no base, so the record is not there yet.
  assert.equal(recordedShip(path, env, 'shipped'), false);
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge shipped', head);
  git(repo, 'push', '-q', 'origin', 'main');
  recordShip(repo, {
    branch: 'shipped',
    sha: git(repo, 'rev-parse', 'HEAD'),
    head,
    task: id,
  });
  assert.equal(recordedShip(path, env, 'shipped'), true);
  // Dropped: the worktree and branch go, the manifest retires, and the verdict stays.
  git(repo, 'worktree', 'remove', '--force', path);
  git(repo, 'branch', '-D', 'shipped');
  retireLane(repo, path, 'test: dropped');
  assert.equal(existsSync(path), false);
  assert.equal(recordedShip(path, env, ''), true);
  assert.equal(recordedShip(repo, env, 'main'), true);
  assert.deepEqual(claimedBranches(repo, env, undefined), ['shipped']);
  // A session that names no lane and no task has no such record.
  assert.equal(recordedShip(repo, {}, 'main'), false);
});

test('a lane with no manifest keeps the legacy verdicts: its claim and its ship record answer', async (t) => {
  const { repo } = startFixture(t);
  const tree = join(repo, '.krn', 'worktrees', 'old-lane');
  git(repo, 'worktree', 'add', '-q', '-b', 'old-lane', tree);
  await claimTask(repo, id, { actor: 'old', worktree: tree, reason: 'legacy' });
  assert.equal(
    listManifests(repo).some((m) => m.slug === 'old-lane'),
    false,
  );
  // The claim names the lane through the task id the session works.
  const env = { KRN_TASK: id };
  assert.equal(claimedWorktree(repo, env, undefined), tree);
  assert.deepEqual(claimedBranches(repo, env, undefined), ['old-lane']);
  writeFileSync(join(tree, 'old.txt'), 'x');
  git(tree, 'add', '.');
  git(tree, 'commit', '-qm', 'feat: old');
  const head = git(tree, 'rev-parse', 'HEAD');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge old', head);
  git(repo, 'push', '-q', 'origin', 'main');
  recordShip(repo, {
    branch: 'old-lane',
    sha: git(repo, 'rev-parse', 'HEAD'),
    head,
    task: id,
  });
  assert.equal(recordedShip(tree, env, 'old-lane'), true);
});

test('a session finds its own lane, not a sibling lane of the same task', async (t) => {
  const { repo } = startFixture(t);
  const first = await startOwn(repo, 'first');
  const second = await startLane([
    'second',
    '--task',
    id,
    '--actor',
    'lane-y',
    '--root',
    repo,
  ]);
  const env = { KRN_LANE_ID: first.manifest.laneId, KRN_TASK: id };
  assert.deepEqual(claimedBranches(repo, env, undefined), ['first']);
  assert.equal(claimedWorktree(repo, env, undefined), first.path);
  assert.notEqual(first.path, second.path);
});
