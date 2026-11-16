import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { namedTests } from '../../src/adopt/verify.ts';

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
  const run = krn(root, '--verify');
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
  const run = krn(root, '--verify');
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
  assert.equal(none.status, 0, none.stdout + none.stderr);
  assert.match(none.stdout, /canary bootstrap/u);
  assert.doesNotMatch(none.stdout, /canary skipped/u);
  assert.doesNotMatch(none.stderr, /everything adopt wrote was removed/u);
  const only = krn(fixture({ 'README.md': 'x\n' }), '--verify');
  assert.equal(only.status, 1);
  const declinedNone = krn(fixture({ 'README.md': 'x\n' }), '--no-canary');
  assert.equal(declinedNone.status, 0, declinedNone.stderr);
});

test('canary passes on a pytest repository and fails with the gate disabled', () => {
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
  const ok = krn(root, '--verify');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  writeFileSync(join(root, '.claude/settings.json'), '{}\n');
  assert.equal(krn(root, '--verify').status, 1);
});

// The canary runs the real cargo, so the test exists only on a host whose cargo has a toolchain.
if (spawnSync('cargo', ['--version']).status === 0) {
  test('canary passes on a cargo repository whose integration test it breaks, and fails with the gate disabled', () => {
    const root = fixture({
      'krn.json': JSON.stringify({
        base: 'main',
        test: 'cargo test',
        tracker: 'none',
      }),
      'Cargo.toml':
        '[package]\nname = "canary_fx"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/lib.rs': 'pub fn one() -> i32 {\n    1\n}\n',
      'tests/smoke.rs':
        '#[test]\nfn one_is_one() {\n    assert_eq!(1, 1);\n}\n',
      '.gitignore': 'target/\n',
    });
    krn(root, '--no-canary');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'adopt');
    const ok = krn(root, '--verify');
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    writeFileSync(join(root, '.claude/settings.json'), '{}\n');
    assert.equal(krn(root, '--verify').status, 1);
  });
}

test('canary passes on a php repository whose test runs under php and fails with the gate disabled', () => {
  const root = fixture({
    'krn.json': JSON.stringify({
      base: 'main',
      test: 'php tests/run.php',
      tracker: 'none',
    }),
    'tests/run.php': '<?php\nif ( 1 + 1 !== 2 ) { exit( 1 ); }\n',
  });
  krn(root, '--no-canary');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'adopt');
  const ok = krn(root, '--verify');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  writeFileSync(join(root, '.claude/settings.json'), '{}\n');
  assert.equal(krn(root, '--verify').status, 1);
});

test('canary breaks the test file the test command names, not another test file', () => {
  const root = fixture({
    'krn.json': JSON.stringify({
      base: 'main',
      test: 'node --test test/*.test.mjs',
      tracker: 'none',
    }),
    'test/a.test.mjs': "import test from 'node:test';\ntest('a', () => {});\n",
    'test/adapters/b.test.ts': 'export {};\n',
  });
  const run = krn(root);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /canary pass: .*test\/a\.test\.mjs/u);
});

test('canary breaks only a file the test command glob selects and fails deliberately when the glob selects none', () => {
  const tsOnly = {
    'package.json': JSON.stringify({
      scripts: { test: 'node --test test/*.test.mjs' },
    }),
    'test/adapters/b.test.ts': 'export {};\n',
  };
  const root = fixture({
    ...tsOnly,
    'krn.json': JSON.stringify({
      base: 'main',
      test: 'node --test test/*.test.mjs',
      tracker: 'none',
    }),
  });
  const run = krn(root);
  assert.equal(run.status, 64, run.stdout + run.stderr);
  assert.match(run.stdout, /names test paths that match no tracked test file/u);
  assert.doesNotMatch(run.stdout, /b\.test\.ts/u);
});

test('a test command too slow to finish is not run whole on the clean tree: the related subset decides', () => {
  const root = fixture({
    ...nodeFiles,
    'krn.json': JSON.stringify({
      base: 'main',
      test: 'sleep 60 && node --test',
      related: 'node --test {files}',
      tracker: 'none',
    }),
  });
  const run = spawnSync(process.execPath, [cli, 'adopt', root], {
    encoding: 'utf8',
    env: { ...process.env, KRN_CANARY_TIMEOUT_MS: '30000' },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('a slow install names the install step as the one that exceeded the limit', () => {
  const root = fixture({
    ...nodeFiles,
    'krn.json': JSON.stringify({
      base: 'main',
      test: 'node --test',
      install: 'sleep 20',
      tracker: 'none',
    }),
  });
  const run = spawnSync(process.execPath, [cli, 'adopt', root], {
    encoding: 'utf8',
    env: { ...process.env, KRN_CANARY_TIMEOUT_MS: '2500' },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(
    run.stdout,
    /canary pending: .*step "install" exceeded it after \d+\.\ds/u,
  );
});

test('adopt on a red clean tree exits 0 in bootstrap state with a seeded green-base task naming the failing command', () => {
  const root = fixture({
    ...nodeFiles,
    'sum.test.js':
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('sum', () => assert.equal(1 + 1, 3));\n",
  });
  // Under `node --test` the child's own `node --test` would join the parent run and exit 0.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const run = spawnSync(process.execPath, [cli, 'adopt', root], {
    encoding: 'utf8',
    env,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(
    run.stdout,
    /canary red-base: red base: the repository's own test command `npm test` exits 1/u,
  );
  assert.doesNotMatch(run.stdout, /does not pass the clean tree/u);
  assert.match(run.stdout, /bootstrap state: the base is red/u);
  assert.doesNotMatch(run.stderr, /everything adopt wrote was removed/u);
  const tasks = readdirSync(join(root, 'tasks')).map((f) =>
    readFileSync(join(root, 'tasks', f), 'utf8'),
  );
  const seeded = tasks.filter((t) =>
    t.includes('make the base test command green'),
  );
  assert.equal(seeded.length, 1);
  assert.match(seeded[0] as string, /npm test/u);
  const again = spawnSync(process.execPath, [cli, 'adopt', root], {
    encoding: 'utf8',
    env,
  });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(readdirSync(join(root, 'tasks')).length, tasks.length);
  const only = spawnSync(process.execPath, [cli, 'adopt', root, '--verify'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(only.status, 69, only.stdout + only.stderr);
});

test('namedTests expands globs from the repository root and reports commands that name none', () => {
  const files = ['test/a.test.mjs', 'test/sub/b.test.mjs', 'test/c.test.ts'];
  assert.deepEqual(namedTests('node --test test/*.test.mjs', files), {
    named: true,
    matched: ['test/a.test.mjs'],
  });
  assert.deepEqual(
    namedTests('node --test test/**/*.test.mjs', files).matched,
    ['test/a.test.mjs', 'test/sub/b.test.mjs'],
  );
  assert.equal(namedTests('npm test', files).named, false);
  assert.equal(namedTests('.venv/bin/python -m pytest', files).named, false);
});

test('namedTests counts a plain script in a test directory as a test file', () => {
  const files = ['index.js', 'test/parse-link-header.js', 'example/use.js'];
  assert.deepEqual(namedTests('tap test/*.js', files), {
    named: true,
    matched: ['test/parse-link-header.js'],
  });
});

test('a slow test command with no related command finishes the canary in under 3x one run', {
  timeout: 175_000,
}, () => {
  const root = fixture({
    ...nodeFiles,
    'krn.json': JSON.stringify({
      base: 'main',
      test: 'sleep 60 && node --test',
      tracker: 'none',
    }),
  });
  // The default bound is 180 s, three runs of the 60 s command: a canary past it is pending, not a pass.
  const run = spawnSync(process.execPath, [cli, 'adopt', root], {
    encoding: 'utf8',
    env: { ...process.env, KRN_CANARY_TIMEOUT_MS: undefined },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /canary pass:/u);
});

test('a canary past its time limit keeps what adopt wrote and reports the canary as pending', () => {
  const root = fixture({
    ...nodeFiles,
    'krn.json': JSON.stringify({
      base: 'main',
      test: 'sleep 20 && node --test',
      tracker: 'none',
    }),
  });
  const run = spawnSync(process.execPath, [cli, 'adopt', root], {
    encoding: 'utf8',
    env: { ...process.env, KRN_CANARY_TIMEOUT_MS: '2500' },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /canary pending: /u);
  assert.match(run.stdout, /step "[^"]+" exceeded it after \d+\.\ds/u);
  assert.doesNotMatch(run.stderr, /removed/u);
  assert.ok(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
  assert.equal(
    spawnSync('git', ['worktree', 'list'], { cwd: root, encoding: 'utf8' })
      .stdout.trim()
      .split('\n').length,
    1,
  );
});
