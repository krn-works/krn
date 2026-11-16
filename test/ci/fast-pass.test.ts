// fast-covers: src/ci/fast-pass.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkedTree } from '../../src/ci/fast-pass.ts';

function git(root: string, ...args: string[]): string {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-fast-pass-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'lane@example.invalid');
  git(root, 'config', 'user.name', 'lane');
  writeFileSync(join(root, '.gitignore'), 'scratch/\n');
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

test('the tree fast checked on a dirty worktree is the HEAD tree once exactly that content is committed', () => {
  const root = repository();
  try {
    writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
    const indexBefore = readFileSync(join(root, '.git', 'index'));
    const checked = checkedTree(root);
    assert.ok(checked);
    assert.notEqual(checked, git(root, 'rev-parse', 'HEAD^{tree}'));
    assert.deepEqual(
      readFileSync(join(root, '.git', 'index')),
      indexBefore,
      'the real index is untouched',
    );
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'lane change');
    assert.equal(git(root, 'rev-parse', 'HEAD^{tree}'), checked);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an edit after fast ran gives a different tree, and ignored files never count', () => {
  const root = repository();
  try {
    const clean = checkedTree(root);
    assert.equal(clean, git(root, 'rev-parse', 'HEAD^{tree}'));
    writeFileSync(join(root, 'scratch-note'), 'x');
    rmSync(join(root, 'scratch-note'));
    mkdirSync(join(root, 'scratch'));
    writeFileSync(join(root, 'scratch', 'log'), 'ignored\n');
    assert.equal(checkedTree(root), clean);
    writeFileSync(join(root, 'a.ts'), 'export const a = 3;\n');
    assert.notEqual(checkedTree(root), clean);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('outside a git repository there is no checked tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-fast-pass-plain-'));
  try {
    assert.equal(checkedTree(root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
