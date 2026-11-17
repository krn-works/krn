import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  checkLaneBudget,
  PRUNE_FLOOR_MS,
  PRUNE_GRACE_MS,
  pruneMergedLanes,
} from '../../src/cli/lane.ts';
import { judgeStop } from '../../src/hook/stop.ts';
import {
  removeFinishedLane,
  worktreeUsers,
} from '../../src/repo/lane-removal.ts';
import { recordShip } from '../../src/repo/ship-record.ts';

function git(cwd: string, ...args: string[]): string {
  const out = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
}

/** A real origin, a main checkout and one lane worktree whose commit origin squash-merged. */
function mergedLane() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'merged-lane-')));
  const origin = join(root, 'origin.git');
  const main = join(root, 'main');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, main);
  git(main, 'config', 'user.email', 'a@b.c');
  git(main, 'config', 'user.name', 'a');
  git(main, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(main, 'package.json'), '{}\n');
  writeFileSync(join(main, '.gitignore'), '.krn/\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'base');
  git(main, 'push', '-q', 'origin', 'main');
  const lane = join(main, '.krn', 'worktrees', 'feat-x');
  mkdirSync(join(main, '.krn', 'worktrees'), { recursive: true });
  git(main, 'worktree', 'add', '-q', '--no-track', '-b', 'feat-x', lane);
  writeFileSync(join(lane, 'a.txt'), 'a\n');
  git(lane, 'add', '.');
  git(lane, 'commit', '-q', '-m', 'change');
  // GitHub squash-merges: the lane commit is never an ancestor of the base.
  git(main, 'merge', '-q', '--squash', 'feat-x');
  git(main, 'commit', '-q', '-m', 'squashed');
  const sha = git(main, 'rev-parse', 'HEAD');
  git(main, 'push', '-q', 'origin', 'main');
  git(main, 'reset', '-q', '--hard', 'HEAD~1');
  git(main, 'fetch', '-q', 'origin');
  return { root, main, lane, sha };
}

/** A host without /proc: process cwds are unknown. */
const noProc = (): undefined => undefined;

const laneEnv = (dir: string) => ({
  CLAUDE_PROJECT_DIR: dir,
  KRN_SESSION_CLASS: 'lane',
  KRN_SCOPE: '',
  KRN_TEST_FIRST: '0',
  KRN_ACCEPTANCE_CLAUSES: '0',
});

test('a lane whose PR merged stops cleanly in the worktree ship left behind', () => {
  const { root, main, lane, sha } = mergedLane();
  try {
    recordShip(main, { branch: 'feat-x', sha });
    assert.ok(existsSync(lane), 'a lane session inside the worktree keeps it');
    const refusal = judgeStop(
      { cwd: lane, last_assistant_message: `verdict: merged ${sha}` },
      laneEnv(lane),
      () => [],
    );
    assert.equal(refusal, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the next lane start prunes a lane whose merge is on the base and keeps an unmerged one', () => {
  const { root, main, lane, sha } = mergedLane();
  try {
    const keep = join(main, '.krn', 'worktrees', 'open-lane');
    git(main, 'worktree', 'add', '-q', '--no-track', '-b', 'open-lane', keep);
    recordShip(main, { branch: 'feat-x', sha });
    recordShip(main, { branch: 'open-lane', sha: 'a'.repeat(40) });
    // Without /proc, a ship younger than the grace period may still have its session in the worktree.
    assert.deepEqual(pruneMergedLanes(main, 'main', Date.now(), noProc), []);
    assert.equal(existsSync(lane), true);
    assert.deepEqual(
      pruneMergedLanes(main, 'main', Date.now() + PRUNE_GRACE_MS, noProc),
      ['feat-x'],
    );
    assert.equal(existsSync(lane), false);
    assert.equal(existsSync(keep), true);
    const branches = git(main, 'branch', '--format=%(refname:short)');
    assert.doesNotMatch(branches, /feat-x/u);
    assert.match(branches, /open-lane/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a merged lane with uncommitted work is not pruned', () => {
  const { root, main, lane, sha } = mergedLane();
  try {
    recordShip(main, { branch: 'feat-x', sha });
    writeFileSync(join(lane, 'wip.txt'), 'unsaved\n');
    assert.deepEqual(
      pruneMergedLanes(main, 'main', Date.now() + PRUNE_GRACE_MS),
      [],
    );
    assert.equal(existsSync(lane), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the lane budget skips a merged clean lane inside the prune grace and lists what it counts', () => {
  const { root, main, lane, sha } = mergedLane();
  const before = process.env.KRN_LANE_MAX_LIVE;
  process.env.KRN_LANE_MAX_LIVE = '1';
  try {
    recordShip(main, { branch: 'feat-x', sha });
    // Young ship on a host without /proc: the grace keeps the worktree, yet the budget does not count it.
    assert.deepEqual(pruneMergedLanes(main, 'main', Date.now(), noProc), []);
    assert.equal(existsSync(lane), true);
    assert.doesNotThrow(() => checkLaneBudget(main, 'main'));

    const open = join(main, '.krn', 'worktrees', 'open-lane');
    git(main, 'worktree', 'add', '-q', '--no-track', '-b', 'open-lane', open);
    assert.throws(
      () => checkLaneBudget(main, 'main'),
      /1 live lane worktrees.*counted: open-lane \(no ship record\)/u,
    );

    // A merged lane with uncommitted work still counts, with its state named.
    git(main, 'worktree', 'remove', '--force', open);
    writeFileSync(join(lane, 'wip.txt'), 'unsaved\n');
    assert.throws(
      () => checkLaneBudget(main, 'main'),
      /counted: feat-x \(merged, uncommitted changes\)/u,
    );
  } finally {
    if (before === undefined) delete process.env.KRN_LANE_MAX_LIVE;
    else process.env.KRN_LANE_MAX_LIVE = before;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a lane worktree that reuses a merged branch name and waits on an open PR is not pruned', () => {
  const { root, main, lane, sha } = mergedLane();
  try {
    // The earlier lane of this branch name shipped: its record names the squash merge on origin.
    const shippedHead = git(lane, 'rev-parse', 'HEAD');
    recordShip(main, { branch: 'feat-x', sha, head: shippedHead });
    // A later lane reuses the name and pushes a new commit whose PR is still open.
    writeFileSync(join(lane, 'b.txt'), 'b\n');
    git(lane, 'add', '.');
    git(lane, 'commit', '-q', '-m', 'second lane, PR open');
    assert.deepEqual(
      pruneMergedLanes(main, 'main', Date.now() + PRUNE_GRACE_MS),
      [],
    );
    assert.equal(existsSync(lane), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the ship cleanup run with its cwd inside the worktree removes the worktree and the branch', () => {
  const { root, main, lane } = mergedLane();
  try {
    const module = new URL('../../src/repo/lane-removal.ts', import.meta.url)
      .pathname;
    // The ship process itself runs inside the worktree: its own cwd never keeps the lane.
    const out = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { removeFinishedLane } = await import(${JSON.stringify(module)});
         process.stdout.write(JSON.stringify(removeFinishedLane(${JSON.stringify(main)}, process.cwd(), 'feat-x')));`,
      ],
      { cwd: lane, encoding: 'utf8' },
    );
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), { removed: true });
    assert.equal(existsSync(lane), false);
    assert.doesNotMatch(
      git(main, 'branch', '--format=%(refname:short)'),
      /feat-x/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a lane another process still works in is kept by ship cleanup and by prune, then pruned once it leaves', () => {
  const { root, main, lane, sha } = mergedLane();
  const session = spawn('sleep', ['30'], { cwd: lane, stdio: 'ignore' });
  try {
    assert.ok(session.pid);
    assert.deepEqual(worktreeUsers(lane), [session.pid]);
    // /proc holds the resolved path: a symlink to the worktree still finds its user.
    const link = join(root, 'lane-link');
    symlinkSync(lane, link);
    assert.deepEqual(worktreeUsers(link), [session.pid]);
    const kept = removeFinishedLane(main, lane, 'feat-x');
    assert.equal(kept.removed, false);
    recordShip(main, { branch: 'feat-x', sha });
    assert.deepEqual(
      pruneMergedLanes(main, 'main', Date.now() + PRUNE_GRACE_MS),
      [],
    );
    assert.equal(existsSync(lane), true);
    session.kill();
    spawnSync('sleep', ['0.2']);
    // A fresh ship stays for the floor: a lane agent may end its session there with no process inside.
    assert.deepEqual(pruneMergedLanes(main, 'main', Date.now()), []);
    // Past the floor and well inside the grace: the lane session has left, so the lane goes.
    assert.deepEqual(
      pruneMergedLanes(main, 'main', Date.now() + PRUNE_FLOOR_MS + 1000),
      ['feat-x'],
    );
    assert.equal(existsSync(lane), false);
  } finally {
    session.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a lane start with a merged worktree at the budget limit prunes it and counts nothing', () => {
  const { root, main, lane, sha } = mergedLane();
  const before = process.env.KRN_LANE_MAX_LIVE;
  process.env.KRN_LANE_MAX_LIVE = '1';
  try {
    recordShip(main, { branch: 'feat-x', sha });
    const later = Date.now() + PRUNE_FLOOR_MS + 1000;
    assert.deepEqual(
      pruneMergedLanes(main, 'main', later, () => []),
      ['feat-x'],
    );
    assert.equal(existsSync(lane), false);
    assert.doesNotThrow(() => checkLaneBudget(main, 'main'));
    // A record whose lane is already gone is not reported again on the next start.
    assert.deepEqual(
      pruneMergedLanes(main, 'main', later, () => []),
      [],
    );
  } finally {
    if (before === undefined) delete process.env.KRN_LANE_MAX_LIVE;
    else process.env.KRN_LANE_MAX_LIVE = before;
    rmSync(root, { recursive: true, force: true });
  }
});
