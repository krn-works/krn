// fast-covers: src/adopt/init.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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

test('--init python leaves no failing standard; php fails only on the composer.lock that composer install writes', () => {
  const py = dir();
  assert.equal(
    krn('adopt', py, '--init', '--stack', 'python', '--no-canary').status,
    0,
  );
  const green = krn('standards', 'check', '--root', py);
  assert.equal(green.status, 0, green.stderr + green.stdout);
  const php = dir();
  assert.equal(
    krn('adopt', php, '--init', '--stack', 'php', '--no-canary').status,
    0,
  );
  const red = krn('standards', 'check', '--root', php);
  assert.deepEqual(
    red.stderr.match(/s-[a-z-]+(?=: exit)/gu),
    ['s-php-composer-lock'],
    red.stderr,
  );
});
