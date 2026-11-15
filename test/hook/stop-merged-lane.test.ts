import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pruneMergedLanes } from '../../src/cli/lane.ts';
import { judgeStop } from '../../src/hook/stop.ts';
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
    assert.ok(existsSync(lane), 'ship leaves the worktree');
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
    assert.deepEqual(pruneMergedLanes(main, 'main'), ['feat-x']);
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
    assert.deepEqual(pruneMergedLanes(main, 'main'), []);
    assert.equal(existsSync(lane), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
