import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// KRN-12: the canary runs against real runners (node --test, vitest, pytest) through the real `krn adopt` entry.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function git(root: string, ...args: string[]) {
  const run = spawnSync(
    'git',
    ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
}

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-canary-fx-'));
  git(root, 'init', '-q', '-b', 'main');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  writeFileSync(join(root, '.gitignore'), 'node_modules\n.krn/\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return root;
}

function krn(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, 'adopt', root, ...args], {
    encoding: 'utf8',
  });
}

const nodeFiles = {
  'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
  'sum.test.js':
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('sum', () => assert.equal(1 + 1, 2));\n",
};

test('canary passes on a node:test repository whose Stop gate works and leaves the clone untouched', () => {
  const root = fixture(nodeFiles);
  assert.equal(krn(root, '--no-canary').status, 0);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'adopt');
  const run = krn(root, '--canary');
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /canary pass: .*exit 2.*exit 0/u);
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(status.stdout, '');
  const trees = spawnSync('git', ['worktree', 'list'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(trees.stdout.trim().split('\n').length, 1);
});

test('canary fails when the Stop hook is disabled', () => {
  const root = fixture(nodeFiles);
  krn(root, '--no-canary');
  writeFileSync(join(root, '.claude/settings.json'), '{}\n');
  const run = krn(root, '--canary');
  assert.equal(run.status, 1);
  assert.match(run.stdout, /canary fail: the Stop hook is not installed/u);
});

test('adopt runs the canary after writing, fails on a red gate and records --no-canary', () => {
  const declined = krn(fixture(nodeFiles), '--no-canary');
  assert.equal(declined.status, 0, declined.stderr);
  assert.match(declined.stdout, /canary declined \(--no-canary\)/u);
  const root = fixture(nodeFiles);
  const run = krn(root);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /canary pass/u);
  const none = krn(fixture({ 'README.md': 'x\n' }));
  assert.equal(none.status, 64);
  assert.match(none.stdout, /canary skipped/u);
  assert.match(none.stderr, /needs one test file/u);
  const only = krn(fixture({ 'README.md': 'x\n' }), '--canary');
  assert.equal(only.status, 1);
  const declinedNone = krn(fixture({ 'README.md': 'x\n' }), '--no-canary');
  assert.equal(declinedNone.status, 0, declinedNone.stderr);
});

test('canary passes on a pytest repository and fails with the gate disabled', (t) => {
  if (spawnSync('pytest', ['--version']).status !== 0)
    return t.skip('quarantine: t-dmpz54r pytest is not installed');
  const root = fixture({
    'krn.json': JSON.stringify({
      base: 'main',
      test: 'pytest -q',
      related: 'pytest -q {files}',
      tracker: 'none',
    }),
    'test_a.py': 'def test_a():\n    assert 1 + 1 == 2\n',
  });
  krn(root, '--no-canary');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'adopt');
  const ok = krn(root, '--canary');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  writeFileSync(join(root, '.claude/settings.json'), '{}\n');
  assert.equal(krn(root, '--canary').status, 1);
});
