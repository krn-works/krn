// fast-covers: src/adopt/init.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { syncLockfile } from '../../src/adopt/init.ts';

// KRN-12: runs the real `krn adopt --init` and `krn standards check` entries on scratch directories.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function krn(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'krn-init-'));
}

function git(root: string, ...args: string[]) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

test('--init on an empty directory gives main, a passing real test, the adoption set and a green standards check', () => {
  const root = dir();
  const run = krn('adopt', root, '--init', '--stack', 'ts');
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.match(run.stdout, /canary pass/u);
  assert.equal(git(root, 'branch', '--show-current').stdout.trim(), 'main');
  assert.equal(git(root, 'rev-list', '--count', 'HEAD').stdout.trim(), '1');
  for (const file of [
    'krn.json',
    'AGENTS.md',
    '.claude/settings.json',
    '.agents/standards.json',
    'tasks',
  ])
    assert.ok(existsSync(join(root, file)), file);
  const tests = spawnSync('npm', ['test', '--silent'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(tests.status, 0, tests.stdout + tests.stderr);
  const check = krn('standards', 'check', '--root', root);
  assert.equal(check.status, 0, check.stderr + check.stdout);
  assert.match(check.stdout, /PASS/u);
});

test('--init detects php from composer.json and python from pyproject.toml', () => {
  const php = dir();
  writeFileSync(join(php, 'composer.json'), '{}\n');
  assert.equal(krn('adopt', php, '--init', '--no-canary').status, 0);
  assert.ok(existsSync(join(php, 'tests/SmokeTest.php')));
  assert.ok(existsSync(join(php, 'phpunit.xml')));
  const py = dir();
  writeFileSync(join(py, 'pyproject.toml'), '[project]\nname = "x"\n');
  assert.equal(krn('adopt', py, '--init', '--no-canary').status, 0);
  assert.ok(existsSync(join(py, 'tests/test_smoke.py')));
});

test('--init python skeleton test passes with its recorded command', () => {
  const root = dir();
  const run = krn('adopt', root, '--init', '--stack', 'python', '--no-canary');
  assert.equal(run.status, 0, run.stderr);
  const tests = spawnSync(
    'python3',
    ['-m', 'unittest', 'discover', '-s', 'tests'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  assert.equal(tests.status, 0, tests.stderr);
});

test('--init without a detectable stack asks for --stack', () => {
  const root = dir();
  const run = krn('adopt', root, '--init', '--no-canary');
  assert.equal(run.status, 64);
  assert.match(run.stderr, /--stack/u);
  assert.equal(existsSync(join(root, '.git')), false);
});

test('--init refuses a git repository with commits and accepts one without', () => {
  const root = dir();
  git(root, 'init', '-q');
  writeFileSync(join(root, 'a.txt'), 'x');
  git(root, 'add', '-A');
  assert.equal(
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x')
      .status,
    0,
  );
  const refused = krn('adopt', root, '--init', '--stack', 'ts', '--no-canary');
  assert.equal(refused.status, 64);
  assert.match(refused.stderr, /plain `krn adopt/u);
  const bare = dir();
  mkdirSync(join(bare, '.git-less'));
  git(bare, 'init', '-q');
  assert.equal(
    krn('adopt', bare, '--init', '--stack', 'ts', '--no-canary').status,
    0,
  );
});

// Born green: an empty directory adopted with --init passes every applicable standard, tracker included.
for (const stack of ['ts', 'php', 'python', 'wp-plugin', 'go', 'rust']) {
  test(`--init ${stack} in an empty directory leaves zero failing standards`, () => {
    const root = dir();
    const run = krn('adopt', root, '--init', '--stack', stack, '--no-canary');
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '', 'init warned that the skeleton is incomplete');
    const check = krn('standards', 'check', '--root', root);
    assert.equal(check.status, 0, check.stderr + check.stdout);
    // A mise go shim with no version in a scratch directory fails `go vet` before it checks anything.
    assert.match(
      check.stdout,
      stack === 'go' ? /, [01] failed,/u : /, 0 failed,/u,
    );
    assert.ok(existsSync(join(root, 'tasks')), 'tracker');
  });
}

test('--init wp-plugin writes a plugin header, a matching readme and a passing PHPUnit test', () => {
  const root = dir();
  const run = krn(
    'adopt',
    root,
    '--init',
    '--stack',
    'wp-plugin',
    '--no-canary',
  );
  assert.equal(run.status, 0, run.stderr);
  const files = spawnSync('git', ['ls-files'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout.split('\n');
  assert.ok(files.includes('readme.txt'));
  assert.ok(files.some((file) => /^[^/]+\.php$/u.test(file)));
  const check = krn(
    'standards',
    'check',
    '--root',
    root,
    '--record',
    's-wp-release-version-matches-readme',
  );
  assert.equal(check.status, 0, check.stderr + check.stdout);
});

test('--init detects wp-plugin from a plugin header and go from go.mod', () => {
  const wp = dir();
  writeFileSync(join(wp, 'composer.json'), '{}\n');
  writeFileSync(
    join(wp, 'demo.php'),
    '<?php\n/**\n * Plugin Name: Demo\n */\n',
  );
  const wpRun = krn('adopt', wp, '--init', '--no-canary');
  assert.equal(wpRun.status, 0, wpRun.stderr);
  assert.match(wpRun.stdout, /init wp-plugin:/u);
  const go = dir();
  writeFileSync(join(go, 'go.mod'), 'module demo\n\ngo 1.22\n');
  const goRun = krn('adopt', go, '--init', '--no-canary');
  assert.equal(goRun.status, 0, goRun.stderr);
  assert.match(goRun.stdout, /init go:/u);
});

test('--init go writes a module, a Go test file and a CI job with the Go toolchain', () => {
  const root = dir();
  assert.equal(
    krn('adopt', root, '--init', '--stack', 'go', '--no-canary').status,
    0,
  );
  const files = git(root, 'ls-files').stdout.split('\n');
  assert.ok(files.includes('go.mod'));
  assert.ok(files.some((file) => file.endsWith('_test.go')));
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /actions\/setup-go@v5/u);
  assert.match(ci, /go test \.\/\.\.\./u);
});

test('the lockfile install survives a transient npm failure and still writes package-lock.json', () => {
  const root = dir();
  const bin = dir();
  // A receiver stand-in: the first call fails as a busy registry or npm cache does under load.
  const fake = join(bin, 'npm');
  writeFileSync(
    fake,
    `#!/bin/sh
if [ ! -e "${bin}/called" ]; then : > "${bin}/called"; echo 'npm error network ECONNRESET' >&2; exit 1; fi
echo '{}' > package-lock.json
`,
  );
  chmodSync(fake, 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  try {
    syncLockfile(root);
  } finally {
    process.env.PATH = before;
  }
  assert.ok(existsSync(join(root, 'package-lock.json')));
});

test('a lockfile install that keeps failing throws npm last line', () => {
  const root = dir();
  const bin = dir();
  const fake = join(bin, 'npm');
  writeFileSync(fake, "#!/bin/sh\necho 'npm error offline' >&2\nexit 1\n");
  chmodSync(fake, 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  try {
    assert.throws(() => syncLockfile(root), /npm error offline/u);
  } finally {
    process.env.PATH = before;
  }
});
