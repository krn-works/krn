import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { gitMetadataBaseline } from '../../src/worker/git-metadata.ts';

// Other lanes fetch and push through the shared common Git directory while a
// worker turn runs; their remote-tracking refs are not the worker's changes.
function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'krn-worker-shared-refs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main');
  const repo = join(root, 'repo');
  mkdirSync(main);
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', main, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  writeFileSync(join(main, 'README.md'), 'base\n');
  git('add', '.');
  git(
    '-c',
    'user.name=worker',
    '-c',
    'user.email=worker@example.invalid',
    'commit',
    '-qm',
    'base',
  );
  git('worktree', 'add', '-qb', 'worker', repo);
  const head = git('rev-parse', 'HEAD');
  const common = join(main, '.git');
  return { repo, head, common };
}

test('shared remote-tracking refs and their packed lines are not worker changes', (t) => {
  assert.equal(typeof gitMetadataBaseline, 'function');
  const s = setup(t);
  writeFileSync(
    join(s.common, 'packed-refs'),
    `# pack-refs with: peeled fully-peeled sorted \n${s.head} refs/heads/keep\n`,
  );
  const check = gitMetadataBaseline(s.repo);
  mkdirSync(join(s.common, 'refs/remotes/origin/feat'), { recursive: true });
  writeFileSync(
    join(s.common, 'refs/remotes/origin/feat/memory-refs'),
    `${s.head}\n`,
  );
  writeFileSync(
    join(s.common, 'packed-refs'),
    `# pack-refs with: peeled fully-peeled sorted \n${s.head} refs/heads/keep\n${s.head} refs/remotes/origin/main\n^${s.head}\n`,
  );
  assert.deepEqual(check(), []);
});

test('local branch refs in the shared Git directory stay protected', (t) => {
  const s = setup(t);
  const loose = gitMetadataBaseline(s.repo);
  writeFileSync(join(s.common, 'refs/heads/forged'), `${s.head}\n`);
  assert.deepEqual(loose(), [join(s.common, 'refs/heads/forged')]);
  const packed = gitMetadataBaseline(s.repo);
  writeFileSync(
    join(s.common, 'packed-refs'),
    `${s.head} refs/remotes/origin/main\n${s.head} refs/heads/forged-packed\n`,
  );
  assert.deepEqual(packed(), [join(s.common, 'packed-refs')]);
});

test('a packed-refs file holding only remote-tracking refs is not a worker change', (t) => {
  const s = setup(t);
  const check = gitMetadataBaseline(s.repo);
  writeFileSync(
    join(s.common, 'packed-refs'),
    `# pack-refs with: peeled fully-peeled sorted \n${s.head} refs/remotes/origin/main\n`,
  );
  assert.deepEqual(check(), []);
});

test('malformed remote-tracking lines in packed-refs stay protected', (t) => {
  const s = setup(t);
  const check = gitMetadataBaseline(s.repo);
  writeFileSync(
    join(s.common, 'packed-refs'),
    `deadbeef refs/remotes/origin/main\n${s.head} refs/remotes/origin/x y\n`,
  );
  assert.deepEqual(check(), [join(s.common, 'packed-refs')]);
});

test('a malformed peeled line after a remote-tracking ref stays protected', (t) => {
  const s = setup(t);
  const check = gitMetadataBaseline(s.repo);
  writeFileSync(
    join(s.common, 'packed-refs'),
    `${s.head} refs/remotes/origin/main\n^not-an-oid\n`,
  );
  assert.deepEqual(check(), [join(s.common, 'packed-refs')]);
});

test('remote-tracking lines with refnames Git rejects stay protected', async (t) => {
  for (const name of [
    'refs/remotes/origin/../main',
    'refs/remotes/origin//main',
    'refs/remotes/origin/.hidden',
    'refs/remotes/origin/main.lock',
    'refs/remotes/origin/main.',
    'refs/remotes/origin/main/',
    'refs/remotes/origin/a@{b',
    'refs/remotes/origin/a~1',
    'refs/remotes/origin/a\\b',
    'refs/remotes/origin/a:b',
    'refs/remotes/origin/a b',
  ])
    await t.test(name, (t) => {
      // Git itself refuses each name, so the case matches its receiver.
      assert.notEqual(
        spawnSync('git', ['check-ref-format', name]).status,
        0,
        name,
      );
      const s = setup(t);
      const check = gitMetadataBaseline(s.repo);
      writeFileSync(join(s.common, 'packed-refs'), `${s.head} ${name}\n`);
      assert.deepEqual(check(), [join(s.common, 'packed-refs')]);
    });
});
