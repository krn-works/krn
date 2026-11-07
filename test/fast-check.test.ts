import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  changedFiles,
  lintable,
  removedFiles,
  selectTests,
  toolBin,
} from '../scripts/fast-check.ts';

const tests = new Map([
  [
    'test/task/claim.test.ts',
    "import { claim } from '../../src/task/claim.ts';",
  ],
  ['test/cli.test.ts', "import { main } from '../src/cli/main.ts';"],
  ['test/other.test.ts', "import x from '../src/task/claimant.ts';"],
  [
    'test/dyn.test.ts',
    "const m = await import('../src/task/lazy.ts');\nimport '../src/side.ts';",
  ],
  ['test/js.test.ts', "import { a } from '../src/pkg/index.js';"],
]);

test('fast check selects changed tests and tests importing a changed module', () => {
  assert.deepEqual(selectTests(['src/task/claim.ts'], tests), [
    'test/task/claim.test.ts',
  ]);
  assert.deepEqual(selectTests(['src/cli/main.ts'], tests), [
    'test/cli.test.ts',
  ]);
  assert.deepEqual(selectTests(['test/other.test.ts', 'docs/x.md'], tests), [
    'test/other.test.ts',
  ]);
  assert.deepEqual(selectTests(['docs/x.md'], tests), []);
});

test('fast check runs the repository rule tests for any change', () => {
  const withRules = new Map([
    ...tests,
    ['test/rules/host-path-guard.test.mjs', ''],
  ]);
  assert.deepEqual(selectTests(['docs/x.md'], withRules), [
    'test/rules/host-path-guard.test.mjs',
  ]);
  assert.deepEqual(selectTests([], withRules), []);
});

test('fast check ignores same-name modules and basename-only matches', () => {
  assert.deepEqual(selectTests(['src/other/claim.ts'], tests), []);
  assert.deepEqual(selectTests(['src/main.ts'], tests), []);
  assert.deepEqual(selectTests(['src/task/claim.ts'], tests), [
    'test/task/claim.test.ts',
  ]);
});

test('fast check resolves dynamic, side-effect and index specifiers', () => {
  assert.deepEqual(selectTests(['src/task/lazy.ts'], tests), [
    'test/dyn.test.ts',
  ]);
  assert.deepEqual(selectTests(['src/side.ts'], tests), ['test/dyn.test.ts']);
  assert.deepEqual(selectTests(['src/pkg/index.ts'], tests), [
    'test/js.test.ts',
  ]);
});

test('fast check runs tests that reference a removed file by import, path or unique basename', () => {
  const refs = new Map([
    ['test/imports.test.ts', "import { x } from '../scripts/gone.mjs';"],
    ['test/joined.test.ts', "spawn(join(root, 'scripts', 'gone.mjs'));"],
    ['test/doc.test.ts', "read('docs/program/old-guide.md');"],
    ['test/cli.test.ts', "run(join('src', 'deliver', 'cli.ts'));"],
    ['test/unrelated.test.ts', "import '../src/kept.ts';"],
  ]);
  // Replay of #259's first push: deleting scripts/gone.mjs left tests spawning it by path.
  assert.deepEqual(
    selectTests([], refs, ['scripts/gone.mjs'], new Set(['src/kept.ts'])),
    ['test/imports.test.ts', 'test/joined.test.ts'],
  );
  assert.deepEqual(
    selectTests([], refs, ['docs/program/old-guide.md'], new Set()),
    ['test/doc.test.ts'],
  );
  // A basename that a surviving file still carries is too broad to match alone.
  assert.deepEqual(
    selectTests([], refs, ['src/deliver/cli.ts'], new Set(['src/cli/cli.ts'])),
    [],
  );
});

test('fast check runs tests that name a changed non-code file by repository path', () => {
  const refs = new Map([
    ['test/workflow.test.ts', "read('docs/program/repository-workflow.md');"],
  ]);
  assert.deepEqual(selectTests(['docs/program/repository-workflow.md'], refs), [
    'test/workflow.test.ts',
  ]);
});

test('fast check lints code files and skips task records and prose', () => {
  assert.deepEqual(
    lintable(['a.ts', 'tasks/t-1.json', 'docs/x.md', 'b.mjs', 'c.json']),
    ['a.ts', 'b.mjs', 'c.json'],
  );
});

test('fast check lists committed, modified and untracked files against the base', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fast-check-'));
  const git = (...args: string[]) =>
    assert.equal(
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: dir,
      }).status,
      0,
    );
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.ts'), '1');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'work');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/b.ts'), '1');
  git('add', '.');
  git('commit', '-qm', 'work');
  writeFileSync(join(dir, 'a.ts'), '2');
  writeFileSync(join(dir, 'new.ts'), '1');
  assert.deepEqual(changedFiles(dir), ['a.ts', 'new.ts', 'src/b.ts']);
});

test('fast check lists deleted and renamed-away files as removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fast-removed-'));
  const git = (...args: string[]) =>
    assert.equal(
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: dir,
      }).status,
      0,
    );
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'gone.ts'), 'export const gone = 1;\n');
  writeFileSync(join(dir, 'moved.ts'), 'export const moved = 1;\n');
  writeFileSync(join(dir, 'unstaged.ts'), '1');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'work');
  git('rm', '-q', 'gone.ts');
  git('mv', 'moved.ts', 'renamed.ts');
  git('commit', '-qm', 'work');
  rmSync(join(dir, 'unstaged.ts'));
  assert.deepEqual(removedFiles(dir), ['gone.ts', 'moved.ts', 'unstaged.ts']);
  assert.deepEqual(changedFiles(dir), ['renamed.ts']);
});

function repoWithChange(): { dir: string; git: (...a: string[]) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'fast-tools-'));
  const git = (...args: string[]) =>
    assert.equal(
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: dir,
      }).status,
      0,
    );
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'test/keep.txt'), '');
  writeFileSync(join(dir, 'a.ts'), '1');
  git('add', '.');
  git('commit', '-qm', 'base');
  writeFileSync(join(dir, 'a.ts'), '2');
  return { dir, git };
}

const script = join(import.meta.dirname, '../scripts/fast-check.ts');
const runFast = (cwd: string) =>
  spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });

test('fast check exits 64 naming the fix when no node_modules exists', () => {
  const { dir } = repoWithChange();
  const result = runFast(dir);
  assert.equal(result.status, 64);
  assert.match(result.stderr, /npm ci/u);
  assert.match(result.stderr, /ln -s/u);
  assert.doesNotMatch(result.stdout, /fast FAIL/u);
});

test('fast check uses the main checkout tools from a worktree without node_modules', () => {
  const { dir, git } = repoWithChange();
  const bin = join(dir, 'node_modules/.bin');
  mkdirSync(bin, { recursive: true });
  const marker = join(dir, 'tsc-ran');
  writeFileSync(join(bin, 'tsc'), `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(join(bin, 'tsc'), 0o755);
  const tree = join(dir, 'wt');
  git('worktree', 'add', '-q', '-b', 'lane', tree, 'HEAD');
  assert.equal(toolBin(tree), bin);
  writeFileSync(join(tree, 'a.ts'), '3');
  const result = runFast(tree);
  assert.notEqual(result.status, 64, result.stderr + result.stdout);
  assert.ok(existsSync(marker), result.stderr + result.stdout);
});
