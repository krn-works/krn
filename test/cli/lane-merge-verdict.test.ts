import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkLaneBudget,
  laneMergeVerdict,
  pruneMergedLanes,
} from '../../src/cli/lane.ts';
import { laneState } from '../../src/cli/lane-status.ts';
import { recordedShip } from '../../src/hook/stop.ts';

delete process.env.KRN_SESSION_CLASS;
// KRN-12: real git repositories and the real `krn lane start`; only the pull request lookup is a stub.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A repository whose lane `slug` shipped one commit that merged on origin/main as a merge commit. */
function shippedLane(slug: string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-verdict-')));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.name', 'verdict test');
  git(repo, 'config', 'user.email', 'verdict@example.invalid');
  git(repo, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), '.krn/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'seed');
  git(repo, 'push', '-q', 'origin', 'main');
  const started = spawnSync(process.execPath, [cli, 'lane', 'start', slug], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.equal(started.status, 0, started.stderr);
  const tree = join(repo, '.krn', 'worktrees', slug);
  const commit = (name: string) => {
    writeFileSync(join(tree, name), name);
    git(tree, 'add', name);
    git(tree, 'commit', '-qm', `feat(lane): ${name} (t-abc1234)`);
  };
  commit('shipped.txt');
  const head = git(tree, 'rev-parse', 'HEAD');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', head);
  git(repo, 'push', '-q', 'origin', 'main');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const dir = join(repo, '.krn', 'runs', 'ship');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slug}.json`),
    `${JSON.stringify({ branch: slug, sha, head, task: 't-abc1234', at: new Date().toISOString() })}\n`,
  );
  return { repo, tree, commit, head, sha };
}

type Pr = { number: number; state: string } | undefined;
const noPr = () => undefined as Pr;

/** What the three callers and the lane budget say about the lane, as one comparable verdict. */
function callers(repo: string, tree: string, slug: string, pr: () => Pr) {
  const status = laneState(repo, 'main', slug, pr).state;
  const stop = recordedShip(tree, {}, slug);
  let budget = 'counted';
  process.env.KRN_LANE_MAX_LIVE = '1';
  process.env.KRN_LANE_MIN_FREE_GB = '0';
  try {
    checkLaneBudget(repo, 'main');
    budget = 'free';
  } catch {
    /* Counted as live. */
  }
  const removed = pruneMergedLanes(
    repo,
    'main',
    Date.now() + 3_600_000,
    () => [],
  );
  return { status, stop, budget, pruned: removed.includes(slug) };
}

test('a lane still at the shipped head is merged for status, Stop, budget and prune', () => {
  const { repo, tree } = shippedLane('whole');
  const seen = callers(repo, tree, 'whole', noPr);
  assert.deepEqual(seen, {
    status: 'merged',
    stop: true,
    budget: 'free',
    pruned: true,
  });
  assert.equal(existsSync(tree), false);
});

test('a branch advanced after a successful ship is unshipped work for every caller', () => {
  const { repo, tree, commit } = shippedLane('later');
  commit('after-ship.txt');
  const seen = callers(repo, tree, 'later', noPr);
  assert.deepEqual(seen, {
    status: 'orphaned',
    stop: false,
    budget: 'counted',
    pruned: false,
  });
  assert.equal(existsSync(tree), true);
});

test('an advanced branch with an open pull request is pr-open and a merged old pull request does not make it merged', () => {
  const { repo, tree, commit } = shippedLane('reused');
  commit('after-ship.txt');
  assert.equal(
    laneState(repo, 'main', 'reused', () => ({ number: 7, state: 'OPEN' }))
      .state,
    'pr-open',
  );
  assert.equal(
    laneState(repo, 'main', 'reused', () => ({ number: 3, state: 'MERGED' }))
      .state,
    'orphaned',
  );
  assert.equal(existsSync(tree), true);
});

test('a closed pull request is closed, not pr-open', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-verdict-')));
  const repo = join(base, 'repo');
  git(base, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.name', 'verdict test');
  git(repo, 'config', 'user.email', 'verdict@example.invalid');
  writeFileSync(join(repo, '.gitignore'), '.krn/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'seed');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(repo, 'remote', 'add', 'origin', join(base, 'origin.git'));
  const tree = join(repo, '.krn', 'worktrees', 'dropped');
  git(repo, 'worktree', 'add', '-q', '-b', 'dropped', tree);
  writeFileSync(join(tree, 'x.txt'), 'x');
  git(tree, 'add', 'x.txt');
  git(tree, 'commit', '-qm', 'feat(lane): x (t-abc1234)');
  const state = (pr: Pr) => laneState(repo, 'main', 'dropped', () => pr);
  assert.equal(state({ number: 5, state: 'CLOSED' }).state, 'closed');
  assert.equal(state({ number: 5, state: 'OPEN' }).state, 'pr-open');
  assert.equal(state({ number: 5, state: 'MERGED' }).state, 'merged');
});

test('laneMergeVerdict decides merged, pr-open, closed and unshipped from the record, the tip and the pull request', () => {
  const onBase = () => true;
  const record = { sha: 'a'.repeat(40), head: 'b'.repeat(40) };
  const verdict = (input: Parameters<typeof laneMergeVerdict>[0]) =>
    laneMergeVerdict(input);
  assert.equal(
    verdict({ record, head: record.head, merged: onBase }),
    'merged',
  );
  assert.equal(
    verdict({ record, head: 'c'.repeat(40), merged: onBase }),
    'unshipped',
  );
  assert.equal(
    verdict({
      record,
      head: 'c'.repeat(40),
      merged: onBase,
      pr: { state: 'closed' },
    }),
    'closed',
  );
  assert.equal(
    verdict({ record, head: record.head, merged: () => false }),
    'unshipped',
  );
  assert.equal(verdict({ merged: onBase, pr: { state: 'OPEN' } }), 'pr-open');
  assert.equal(verdict({ merged: onBase }), 'unshipped');
});
