import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

test('fast check --base replays a merged deleted-file commit without a reset', () => {
  const { dir, git } = repoWithChange();
  const bin = join(dir, 'node_modules/.bin');
  mkdirSync(bin, { recursive: true });
  for (const tool of ['tsc', 'biome']) {
    writeFileSync(join(bin, tool), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, tool), 0o755);
  }
  writeFileSync(join(dir, 'gone.ts'), 'export const gone = 1;\n');
  writeFileSync(
    join(dir, 'test/ref.test.ts'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { existsSync } from 'node:fs';\ntest('gone.ts stays', () => assert.ok(existsSync('gone.ts')));\n",
  );
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: dir,
    encoding: 'utf8',
  }).stdout.trim();
  git('rm', '-q', 'gone.ts');
  git('commit', '-qm', 'delete');
  const plain = runFast(dir);
  assert.match(plain.stdout, /PASS: no changed files/u);
  const replay = spawnSync(process.execPath, [script, '--base', base], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  assert.equal(replay.status, 1, replay.stderr + replay.stdout);
  assert.match(replay.stdout, /fast FAIL \(test\)/u);
});

test('fast check exits 64 for an unknown --base commit or a missing value', () => {
  const { dir } = repoWithChange();
  for (const args of [['--base', 'nope'], ['--base'], ['--bogus']]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 64, result.stderr);
    assert.match(result.stderr, /^fast: /u);
    assert.equal(result.stdout, '');
  }
});

test('fast check exits 2 naming the git command when cwd is outside any repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fast-norepo-'));
  const result = spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() },
  });
  assert.equal(result.status, 2, result.stderr + result.stdout);
  assert.match(result.stderr, /^fast: `git [^`]+` failed/u);
  assert.doesNotMatch(result.stdout, /PASS/u);
});

test('fast check exits 2 naming the git command when the index is corrupt', () => {
  const { dir } = repoWithChange();
  writeFileSync(join(dir, '.git/index'), 'not an index');
  const result = runFast(dir);
  assert.equal(result.status, 2, result.stderr + result.stdout);
  assert.match(result.stderr, /^fast: `git [^`]+` failed/u);
  assert.doesNotMatch(result.stdout, /PASS/u);
});

test('fast check exits 2 when no merge base exists instead of diffing HEAD', () => {
  const { dir, git } = repoWithChange();
  git('branch', '-m', 'main', 'topic');
  const result = runFast(dir);
  assert.equal(result.status, 2, result.stderr + result.stdout);
  assert.match(result.stderr, /no merge base .* pass --base/u);
});

function stubTools(dir: string, tsc: string): void {
  const bin = join(dir, 'node_modules/.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'tsc'), `#!/bin/sh\n${tsc}\n`);
  writeFileSync(join(bin, 'biome'), '#!/bin/sh\n');
  chmodSync(join(bin, 'tsc'), 0o755);
  chmodSync(join(bin, 'biome'), 0o755);
}

test('fast check reuses a cached pass on an unchanged tree and any edit invalidates it', () => {
  const { dir } = repoWithChange();
  const runs = join(dir, 'tsc-runs');
  stubTools(dir, `echo x >> ${runs}`);
  const count = () => readFileSync(runs, 'utf8').split('\n').length - 1;
  const first = runFast(dir);
  assert.match(first.stdout, /fast PASS:/u, first.stderr + first.stdout);
  assert.equal(count(), 1);
  const second = runFast(dir);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /fast PASS \(cached\):/u);
  assert.equal(count(), 1);
  writeFileSync(join(dir, 'a.ts'), '3');
  assert.match(runFast(dir).stdout, /fast PASS:/u);
  assert.equal(count(), 2);
  writeFileSync(join(dir, 'new.ts'), '4');
  assert.doesNotMatch(runFast(dir).stdout, /cached/u);
  assert.equal(count(), 3);
});

test('fast check does not cache a FAIL and a changed base misses', () => {
  const { dir, git } = repoWithChange();
  const verdict = join(dir, 'verdict');
  stubTools(dir, `exit $(cat ${verdict})`);
  writeFileSync(verdict, '1');
  assert.equal(runFast(dir).status, 1);
  writeFileSync(verdict, '0');
  assert.match(runFast(dir).stdout, /fast PASS:/u);
  assert.match(runFast(dir).stdout, /cached/u);
  git('commit', '--allow-empty', '-qm', 'moves the base');
  assert.doesNotMatch(runFast(dir).stdout, /cached/u);
});
