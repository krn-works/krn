import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readLane, readShipRecord, shipRecords } from '../../src/lane/state.ts';
import { shipRecordDir } from '../../src/repo/ship-record.ts';

// KRN-12: real git repositories; the ship record is written as `krn pr ship` writes it.
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A main checkout whose lane `slug` committed once and merged on origin/main as a merge commit. */
function mergedLane(slug: string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-lane-state-')));
  const origin = join(base, 'origin.git');
  const main = join(base, 'repo');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, main);
  git(main, 'config', 'user.name', 'lane state test');
  git(main, 'config', 'user.email', 'lane-state@example.invalid');
  git(main, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(main, '.gitignore'), '.krn/\n');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'seed');
  git(main, 'push', '-q', 'origin', 'main');
  const tree = join(main, '.krn', 'worktrees', slug);
  git(main, 'worktree', 'add', '-q', '-b', slug, tree);
  const commit = (name: string) => {
    writeFileSync(join(tree, name), name);
    git(tree, 'add', name);
    git(tree, 'commit', '-qm', `feat(lane): ${name}`);
    return git(tree, 'rev-parse', 'HEAD');
  };
  const head = commit('shipped.txt');
  git(main, 'merge', '-q', '--no-ff', '-m', 'merge', head);
  git(main, 'push', '-q', 'origin', 'main');
  const sha = git(main, 'rev-parse', 'HEAD');
  const record = (fields: Record<string, unknown>) => {
    mkdirSync(join(main, shipRecordDir), { recursive: true });
    writeFileSync(
      join(main, shipRecordDir, `${encodeURIComponent(slug)}.json`),
      `${JSON.stringify(fields)}\n`,
    );
  };
  return { main, tree, head, sha, commit, record };
}

const later = () => new Date(Date.now() + 60_000).toISOString();

test('one parser reads ship records and skips a record without a branch, with a bad sha or not JSON', () => {
  const { main, sha, head, record } = mergedLane('parsed');
  record({ branch: 'parsed', sha, head, at: 'x', task: 't-abc1234' });
  const dir = join(main, shipRecordDir);
  writeFileSync(join(dir, 'nobranch.json'), JSON.stringify({ sha }));
  writeFileSync(
    join(dir, 'badsha.json'),
    JSON.stringify({ branch: 'badsha', sha: 'HEAD' }),
  );
  writeFileSync(join(dir, 'torn.json'), '{"branch":');
  const expected = {
    branch: 'parsed',
    sha,
    head,
    at: 'x',
    task: 't-abc1234',
  };
  assert.deepEqual(shipRecords(main), [expected]);
  assert.deepEqual(readShipRecord(main, 'parsed'), expected);
  assert.equal(readShipRecord(main, 'badsha'), undefined);
  assert.equal(readShipRecord(main, 'absent'), undefined);
});

test('a kept worktree at the shipped head is merged; once the branch moves on it is unshipped work', () => {
  const { main, tree, head, sha, commit, record } = mergedLane('kept');
  const at = later();
  record({ branch: 'kept', sha, head, at });
  assert.deepEqual(readLane(main, 'main', 'kept'), {
    verdict: 'merged',
    record: { branch: 'kept', sha, head, at },
    worktree: tree,
    tip: head,
  });
  commit('after-ship.txt');
  assert.equal(readLane(main, 'main', 'kept').verdict, 'unshipped');
  assert.equal(
    readLane(main, 'main', 'kept', { state: 'OPEN' }).verdict,
    'pr-open',
  );
  // An older merged pull request of the reused branch name does not own the new tip.
  assert.equal(
    readLane(main, 'main', 'kept', { state: 'MERGED' }).verdict,
    'unshipped',
  );
});

test('a lane whose worktree is gone reads its tip from the branch, and with both gone still reads its record', () => {
  const { main, tree, head, sha, record } = mergedLane('gone');
  record({ branch: 'gone', sha, head, at: later() });
  git(main, 'worktree', 'remove', '--force', tree);
  const branchOnly = readLane(main, 'main', 'gone');
  assert.equal(branchOnly.worktree, undefined);
  assert.equal(branchOnly.tip, head);
  assert.equal(branchOnly.verdict, 'merged');
  git(main, 'branch', '-D', 'gone');
  const retired = readLane(main, 'main', 'gone');
  assert.equal(retired.tip, undefined);
  assert.equal(retired.verdict, 'merged');
});

test('a record without a head owns a tip committed no later than the ship', () => {
  const { main, sha, record } = mergedLane('headless');
  record({ branch: 'headless', sha, at: later() });
  assert.equal(readLane(main, 'main', 'headless').verdict, 'merged');
  record({ branch: 'headless', sha, at: '2001-01-01T00:00:00.000Z' });
  assert.equal(readLane(main, 'main', 'headless').verdict, 'unshipped');
});

test('a merge the main checkout has not fetched is not merged yet; a pull request alone decides without a record', () => {
  const { main, head, sha, record } = mergedLane('unfetched');
  record({ branch: 'unfetched', sha, head, at: later() });
  git(main, 'update-ref', 'refs/remotes/origin/main', `${sha}^1`);
  assert.equal(readLane(main, 'main', 'unfetched').verdict, 'unshipped');
  rmSync(join(main, shipRecordDir), { recursive: true });
  assert.equal(
    readLane(main, 'main', 'unfetched', { state: 'MERGED' }).verdict,
    'merged',
  );
  assert.equal(
    readLane(main, 'main', 'unfetched', { state: 'CLOSED' }).verdict,
    'closed',
  );
});
