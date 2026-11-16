import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  changedFiles,
  cliCommandModules,
  evidenceTests,
  fullyStaged,
  lintable,
  parseArgs,
  removedFiles,
  restage,
  selectTests,
  toolBin,
  treeKey,
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

test('a fast-only test runs only when the diff touches its declared inputs', () => {
  // planted-records imports src/cli/main.ts, so before fast-only every src change ran its 3-minute matrix.
  const slow = new Map([
    [
      'test/scripts/planted.test.ts',
      "// fast-only: standards/records.json src/adopt/\nimport { main } from '../../src/cli/main.ts';",
    ],
  ]);
  assert.deepEqual(selectTests(['src/cli/main.ts'], slow), []);
  assert.deepEqual(selectTests(['src/adopt/init.ts'], slow), [
    'test/scripts/planted.test.ts',
  ]);
  assert.deepEqual(selectTests(['standards/records.json'], slow), [
    'test/scripts/planted.test.ts',
  ]);
  assert.deepEqual(selectTests(['test/scripts/planted.test.ts'], slow), [
    'test/scripts/planted.test.ts',
  ]);
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

test('fast check runs the tree-wide tests a new src module, script or hook trips', () => {
  const tree = new Map([
    ['test/import-boundary.test.ts', ''],
    ['test/tool-scope.test.ts', ''],
    ['test/cli/hook.test.ts', ''],
    ['test/other.test.ts', ''],
  ]);
  const edit = [
    '.claude/settings.json',
    'spec/receivers.json',
    'src/hook/edit-standards.ts',
    'test/hook/fixtures/pretooluse-edit-write-php.jsonl',
  ];
  assert.deepEqual(selectTests(edit, tree), [
    'test/cli/hook.test.ts',
    'test/import-boundary.test.ts',
    'test/tool-scope.test.ts',
  ]);
  assert.deepEqual(selectTests(['src/task/new.ts'], tree), [
    'test/import-boundary.test.ts',
    'test/tool-scope.test.ts',
  ]);
  assert.deepEqual(selectTests([], tree, ['src/gone.ts']), [
    'test/import-boundary.test.ts',
    'test/tool-scope.test.ts',
  ]);
  assert.deepEqual(selectTests(['docs/x.md'], tree), []);
});

test('fast check selects prose rule tests only when the diff touches prose paths', () => {
  const rules = new Map([
    ['test/rules/host-path-guard.test.mjs', ''],
    ['test/rules/instruction-bytes.test.ts', ''],
    ['test/rules/project-skills.test.ts', ''],
  ]);
  assert.deepEqual(selectTests(['src/x/y.ts'], rules), [
    'test/rules/host-path-guard.test.mjs',
  ]);
  assert.deepEqual(selectTests(['AGENTS.md'], rules), [
    'test/rules/host-path-guard.test.mjs',
    'test/rules/instruction-bytes.test.ts',
    'test/rules/project-skills.test.ts',
  ]);
  assert.deepEqual(selectTests([], rules, ['src/gone.ts']).length, 1);
  assert.deepEqual(selectTests([], rules, ['docs/gone.md']).length, 3);
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
// PR_BODY may carry a Weakens-tests override from the caller; the child must not inherit it.
// NODE_TEST_CONTEXT would turn the child's own node --test runs into silent subtests that exit 0.
const { PR_BODY: _body, NODE_TEST_CONTEXT: _context, ...fastEnv } = process.env;
const runFast = (cwd: string) =>
  spawnSync(process.execPath, [script], {
    cwd,
    encoding: 'utf8',
    env: fastEnv,
  });

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
  const runs = `${dir}-tsc-runs`;
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

test('an explicit --base that moved past the branch point diffs only the branch own changes', () => {
  const { dir, git } = repoWithChange();
  git('checkout', '-q', '--', 'a.ts');
  git('checkout', '-q', '-b', 'topic');
  writeFileSync(join(dir, 'mine.ts'), 'mine');
  git('add', '.');
  git('commit', '-qm', 'branch change');
  git('checkout', '-q', 'main');
  writeFileSync(join(dir, 'other.ts'), 'other');
  git('add', '.');
  git('commit', '-qm', 'main moved');
  git('checkout', '-q', 'topic');
  const parsed = parseArgs(dir, ['--base', 'main']);
  assert.ok('base' in parsed && parsed.base !== undefined);
  assert.deepEqual(changedFiles(dir, parsed.base), ['mine.ts']);
  assert.deepEqual(removedFiles(dir, parsed.base), []);
});

test('a passing run records the tree it checked, so committing exactly that content gives ship the same HEAD tree', () => {
  const { dir, git } = repoWithChange();
  git('add', '.');
  git('commit', '-qm', 'change');
  stubTools(dir, 'exit 0');
  // As in a real clone, tool and state directories are ignored.
  writeFileSync(join(dir, '.git/info/exclude'), 'node_modules\n.krn\n');
  const record = join(dir, '.krn/tmp/fast-pass-tree');
  const rev = (what: string) =>
    spawnSync('git', ['rev-parse', what], {
      cwd: dir,
      encoding: 'utf8',
    }).stdout.trim();
  const fast = () =>
    spawnSync(process.execPath, [script, '--base', rev('HEAD~1')], {
      cwd: dir,
      encoding: 'utf8',
      env: fastEnv,
    });
  const clean = fast();
  assert.match(clean.stdout, /fast PASS/u, clean.stderr + clean.stdout);
  assert.equal(readFileSync(record, 'utf8').trim(), rev('HEAD^{tree}'));
  // Lanes run fast before committing: the dirty tree it checked is what the commit holds.
  writeFileSync(join(dir, 'a.ts'), 'edited');
  assert.match(fast().stdout, /fast PASS/u);
  const checked = readFileSync(record, 'utf8').trim();
  assert.notEqual(checked, rev('HEAD^{tree}'));
  git('add', '-A');
  git('commit', '-qm', 'edit');
  assert.equal(rev('HEAD^{tree}'), checked);
});

// Regression (t-aevqyv5): the harness sandbox binds /dev/null over protected paths in the
// clone root, so they are character devices; `git add -A` failed on them and fast exited 2.
// An unprivileged mknod is impossible, so the device is made with bwrap; the device half is not run without it.
const bwrapWorks =
  spawnSync('bwrap', ['--dev-bind', '/', '/', 'true']).status === 0;

test('fast check keys and lists a tree holding device placeholders and a deleted tracked file', () => {
  const { dir, git } = repoWithChange();
  writeFileSync(join(dir, 'gone.ts'), '1');
  git('add', 'gone.ts');
  git('commit', '-qm', 'adds gone');
  const base = 'a'.repeat(40);
  // Without bwrap only the deleted-file half runs, in-process.
  if (!bwrapWorks) {
    const before = treeKey(dir, base);
    rmSync(join(dir, 'gone.ts'));
    assert.notEqual(treeKey(dir, base), before);
    return;
  }
  writeFileSync(join(dir, '.bashrc'), '');
  const script = join(dir, '.krn-key.mts');
  const module = JSON.stringify(join(process.cwd(), 'scripts/fast-check.ts'));
  writeFileSync(
    script,
    `import { changedFiles, treeKey } from ${module};
import { rmSync } from 'node:fs';
const base = 'HEAD';
const before = treeKey(process.cwd(), base);
rmSync('gone.ts');
console.log(before.length, treeKey(process.cwd(), base) !== before, changedFiles(process.cwd(), base).includes('.bashrc'));
`,
  );
  const run = spawnSync(
    'bwrap',
    [
      '--dev-bind',
      '/',
      '/',
      '--ro-bind',
      '/dev/null',
      join(dir, '.bashrc'),
      'node',
      script,
    ],
    { cwd: dir, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '64 true false');
});

// Regression (#509): `git add -A && npm run fast && git commit` lost Biome's
// rewrite because it landed after the add.
test('fast check re-stages fixes to fully staged files only', () => {
  const root = mkdtempSync(join(tmpdir(), 'fast-restage-'));
  try {
    const git = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: root,
        encoding: 'utf8',
      });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(root, 'a.ts'), 'a\n');
    writeFileSync(join(root, 'b.ts'), 'b\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    writeFileSync(join(root, 'a.ts'), 'a2\n');
    writeFileSync(join(root, 'b.ts'), 'b2\n');
    git('add', 'a.ts', 'b.ts');
    writeFileSync(join(root, 'b.ts'), 'b3 author edit\n');
    const staged = fullyStaged(root);
    assert.deepEqual(staged, ['a.ts']);
    writeFileSync(join(root, 'a.ts'), 'a2 formatted\n');
    assert.deepEqual(restage(root, staged), ['a.ts']);
    assert.equal(git('diff', '--name-only').stdout, 'b.ts\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fast check selects a test whose fast-covers prefix matches a changed path', () => {
  const covering = new Map([
    [
      'test/portability/fixtures.test.ts',
      "// fast-covers: src/repo/ src/adopt/\nimport x from 'y';",
    ],
    ['test/other.test.ts', 'no header; mentions src/repo/ in prose only'],
  ]);
  assert.deepEqual(selectTests(['src/repo/contract.ts'], covering), [
    'test/portability/fixtures.test.ts',
  ]);
  assert.deepEqual(selectTests(['src/adopt/adopt.ts'], covering), [
    'test/portability/fixtures.test.ts',
  ]);
  assert.deepEqual(selectTests(['src/task/claim.ts'], covering), []);
});

// Regression (t-ef75x2q): fast passed while CI's Weakened tests step failed on net removed assertions.
test('fast check fails naming weak-tests when the working tree removes an assertion', () => {
  const { dir, git } = repoWithChange();
  const body =
    "import assert from 'node:assert/strict';\nassert.equal(1, 1);\n";
  writeFileSync(join(dir, 'test/x.test.ts'), `${body}assert.equal(2, 2);\n`);
  git('add', '.');
  git('commit', '-qm', 'adds a test');
  writeFileSync(join(dir, 'test/x.test.ts'), body);
  stubTools(dir, 'exit 0');
  const result = runFast(dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /fast FAIL \(weak-tests\)/u);
  assert.match(
    result.stdout,
    /test\/x\.test\.ts: net 1 assertion\(s\) removed/u,
  );
});

test('fast check stops on a broken rule in preflight, naming it, before any related test starts', () => {
  const { dir } = repoWithChange();
  mkdirSync(join(dir, 'test/rules'));
  writeFileSync(
    join(dir, 'test/rules/no-wall-clock.test.ts'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('wall-clock assertions are forbidden', () => assert.fail('a.ts asserts on Date.now'));\n",
  );
  writeFileSync(
    join(dir, 'test/a.test.ts'),
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('related-ran', '');\nimport './../a.ts';\n",
  );
  stubTools(dir, 'exit 0');
  const result = runFast(dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /fast FAIL \(guard\): preflight stopped/u);
  assert.match(result.stdout, /rule: .*wall-clock assertions are forbidden/u);
  assert.equal(existsSync(join(dir, 'related-ran')), false);
});

test('fast check selects the CLI-subprocess tests that assert the repo contract detection', () => {
  const real = new Map(
    [
      'test/adopt/adopt.test.ts',
      'test/adopt/universal-skills.test.ts',
      'test/cli/lane-brief.test.ts',
    ].map((path) => [path, readFileSync(path, 'utf8')]),
  );
  assert.deepEqual(selectTests(['src/repo/contract.ts'], real), [
    'test/adopt/adopt.test.ts',
    'test/adopt/universal-skills.test.ts',
    'test/cli/lane-brief.test.ts',
  ]);
});

test('fast check derives the src modules a bin/krn subprocess test covers', () => {
  const root = mkdtempSync(join(tmpdir(), 'fast-cli-'));
  try {
    mkdirSync(join(root, 'src/cli'), { recursive: true });
    mkdirSync(join(root, 'src/ledger'), { recursive: true });
    writeFileSync(
      join(root, 'src/cli/index.ts'),
      "if (command === 'ledger') {\n  const { run } = await import('./ledger.ts');\n} else if (command === 'plan') {\n  const { p } = await import('./plan.ts');\n}\n",
    );
    writeFileSync(
      join(root, 'src/cli/ledger.ts'),
      "import { rows } from '../ledger/rows.ts';\n",
    );
    writeFileSync(join(root, 'src/ledger/rows.ts'), 'export const rows = 1;\n');
    writeFileSync(join(root, 'src/cli/plan.ts'), 'export const p = 1;\n');
    const modules = cliCommandModules(root);
    assert.ok(modules.get('ledger')?.has('src/ledger/rows.ts'));
    assert.ok(!modules.get('plan')?.has('src/ledger/rows.ts'));
    const spawning = new Map([
      [
        'test/cli/ledger-cli.test.ts',
        "spawnSync('bin/krn', ['ledger', 'show']);",
      ],
      ['test/cli/plan-cli.test.ts', "spawnSync('bin/krn', ['plan']);"],
      ['test/other.test.ts', "const c = 'ledger'; // no spawn"],
    ]);
    assert.deepEqual(
      selectTests(['src/ledger/rows.ts'], spawning, [], new Set(), modules),
      ['test/cli/ledger-cli.test.ts'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// KRN-12: the repository's own standards records are the receiver's input.
test('a file a standards record names as evidence selects the standards test', () => {
  const records = readFileSync('standards/records.json', 'utf8');
  assert.deepEqual(evidenceTests(['src/repo/contract.ts'], records), [
    'test/brain/standards.test.ts',
  ]);
  assert.deepEqual(evidenceTests(['src/ci/ship.ts'], records), []);
});

// KRN-12: the real repository and the real canary test are the receiver of the selection.
test('changing the adopt canary selects the test that spawns the CLI entry with adopt', () => {
  const canary = 'test/adopt/canary.test.ts';
  const source = readFileSync(canary, 'utf8');
  const modules = cliCommandModules('.');
  assert.ok(modules.get('adopt')?.has('src/adopt/verify.ts'));
  assert.ok(
    selectTests(
      ['src/adopt/verify.ts'],
      new Map([[canary, source]]),
      [],
      new Set(),
      modules,
    ).includes(canary),
  );
});

test('fast check selects the readers of a changed data file on the real repository', () => {
  const real = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.test\.(ts|mjs)$/u.test(path))
        real.set(path, readFileSync(path, 'utf8'));
    }
  };
  walk('test');
  assert.ok(
    selectTests(['AGENTS.md'], real).includes('test/brain/standards.test.ts'),
  );
  assert.ok(
    selectTests(['standards/records.json'], real).includes(
      'test/brain/standards.test.ts',
    ),
  );
  assert.ok(
    selectTests(['spec/context-budget.json'], real).includes(
      'test/rules/context-budget.test.ts',
    ),
  );
});

test('two fast-check test phases against one slot lock run one after the other', async () => {
  const { withSlot } = await import('../scripts/lib/slot-lock.ts');
  const dir = mkdtempSync(join(tmpdir(), 'slots-'));
  try {
    const events: string[] = [];
    const phase = (name: string) =>
      withSlot({ dir, slots: 1, pollMs: 10 }, async () => {
        events.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, 80));
        events.push(`${name}:end`);
      });
    await Promise.all([phase('a'), phase('b')]);
    assert.deepEqual(events, ['a:start', 'a:end', 'b:start', 'b:end']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a slot whose holder died is reclaimed and the cap comes from KRN_FAST_SLOTS', async () => {
  const { withSlot } = await import('../scripts/lib/slot-lock.ts');
  const { testSlotOptions } = await import('../scripts/fast-check.ts');
  const dir = mkdtempSync(join(tmpdir(), 'slots-'));
  try {
    mkdirSync(join(dir, 'slot-0'));
    writeFileSync(join(dir, 'slot-0', 'pid'), '999999999');
    const ran = await withSlot({ dir, pollMs: 10 }, async () => 'ok');
    assert.equal(ran, 'ok');
    assert.equal(testSlotOptions(dir, { KRN_FAST_SLOTS: '3' }).slots, 3);
    assert.equal(testSlotOptions(dir, {}, 16).slots, 2);
    assert.equal(testSlotOptions(dir, {}, 4).slots, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selectTests picks a test that imports a changed module through two import hops', () => {
  const sources = new Map([
    ['src/context/replay.ts', "import { gauge } from './gauge.ts';"],
    ['src/context/gauge.ts', 'export const gauge = 1;'],
  ]);
  const suite = new Map([
    [
      'test/claude/context-replay.test.ts',
      "import { replay } from '../../src/context/replay.ts';",
    ],
    ['test/unrelated.test.ts', "import x from '../src/other.ts';"],
  ]);
  assert.deepEqual(
    selectTests(
      ['src/context/gauge.ts'],
      suite,
      [],
      new Set(),
      new Map(),
      (path) => sources.get(path),
    ),
    ['test/claude/context-replay.test.ts'],
  );
});

test('selectTests selects test/claude/context-replay.test.ts for src/context/gauge.ts in this repository', () => {
  const root = join(import.meta.dirname, '..');
  const suite = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.test\.ts$/u.test(entry.name))
        suite.set(rel, readFileSync(join(root, rel), 'utf8'));
    }
  };
  walk('test');
  const picked = selectTests(
    ['src/context/gauge.ts'],
    suite,
    [],
    new Set(),
    new Map(),
    (path) =>
      existsSync(join(root, path))
        ? readFileSync(join(root, path), 'utf8')
        : undefined,
  );
  assert.ok(picked.includes('test/claude/context-replay.test.ts'));
});

test('fast check runs the CI rule coverage test when a test/rules file is added or renamed', () => {
  const coverage = 'test/brain/ci-rule-coverage.test.ts';
  const tests = new Map([
    [coverage, ''],
    ['test/rules/json-schema-subset.test.ts', ''],
    ['test/other.test.ts', ''],
  ]);
  const added = selectTests(['test/rules/json-schema-subset.test.ts'], tests);
  assert.ok(added.includes(coverage));
  const renamed = selectTests([], tests, ['test/rules/old-name.test.ts']);
  assert.ok(renamed.includes(coverage));
  assert.ok(!selectTests(['test/other.test.ts'], tests).includes(coverage));
});

test('fast prints a FAIL verdict naming the stage when its first stage crashes or exits early', async () => {
  const { main } = await import('../scripts/fast-check.ts');
  const dir = mkdtempSync(join(tmpdir(), 'fast-verdict-'));
  try {
    const lines: string[] = [];
    const write = (text: string): void => {
      lines.push(text);
    };
    // Not a repository: git fails before any check (exit 2), formerly with no verdict line.
    assert.equal(await main(dir, [], write), 2);
    assert.match(lines.join(''), /^fast FAIL \(git\): exit 2/mu);
    lines.length = 0;
    spawnSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(join(dir, 'standards'));
    writeFileSync(join(dir, 'standards', 'records.json'), '{bad');
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'],
      { cwd: dir },
    );
    // The standards index refresh throws on the broken pack: the crash still ends in a verdict.
    assert.equal(await main(dir, [], write), 1);
    assert.match(lines.join(''), /^fast FAIL \(index\): crashed: /mu);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
