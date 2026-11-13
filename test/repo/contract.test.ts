import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  ContractError,
  parseContractFile,
  relatedCommand,
  resolveContract,
} from '../../src/repo/contract.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture(files: Record<string, string>, branch?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-contract-'));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  if (branch) {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q', '-b', branch);
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    );
  }
  return root;
}

test('each stack is detected with its test and related commands', () => {
  const cases: [Record<string, string>, string, string, string | undefined][] =
    [
      [{ 'Cargo.toml': '' }, 'rust', 'cargo test', undefined],
      [{ 'go.mod': 'module x' }, 'go', 'go test ./...', 'go test {files}'],
      [
        { 'pyproject.toml': '' },
        'python',
        'python -m pytest',
        'python -m pytest {files}',
      ],
      [
        { 'pyproject.toml': '', 'uv.lock': '' },
        'python',
        'uv run pytest',
        'uv run pytest {files}',
      ],
      [
        {
          'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
          'pnpm-lock.yaml': '',
        },
        'node/pnpm',
        'pnpm test',
        'pnpm exec vitest run {files}',
      ],
      [
        { 'package.json': JSON.stringify({ scripts: { test: 'jest --ci' } }) },
        'node/npm',
        'npm test',
        'npx jest {files}',
      ],
      [
        { Makefile: 'build:\n\ttrue\ntest:\n\ttrue\n' },
        'make',
        'make test',
        undefined,
      ],
    ];
  for (const [files, stack, testCommand, related] of cases) {
    const resolved = resolveContract(fixture(files));
    assert.equal(resolved.source, 'detected');
    assert.equal(resolved.stack, stack, stack);
    assert.equal(resolved.contract.test, testCommand, stack);
    assert.equal(resolved.contract.related, related, stack);
    assert.equal(resolved.contract.tracker, 'none', stack);
  }
});

test('npm init placeholder test script is not a test command, and nothing found names krn.json', () => {
  const root = fixture({
    'package.json': JSON.stringify({
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
    }),
  });
  assert.throws(
    () => resolveContract(root),
    (e: unknown) => e instanceof ContractError && /krn\.json/.test(e.message),
  );
});

test('krn.json fields win and missing ones fall back to detection', () => {
  const root = fixture({
    'pyproject.toml': '',
    'krn.json': JSON.stringify({
      base: 'develop',
      fast: 'ruff check .',
      guard: 'tests/invariants/',
    }),
    'tasks/.keep': '',
  });
  const { contract, source } = resolveContract(root);
  assert.equal(source, 'krn.json');
  assert.deepEqual(contract, {
    base: 'develop',
    test: 'python -m pytest',
    related: 'python -m pytest {files}',
    fast: 'ruff check .',
    guard: 'tests/invariants/',
    tracker: 'krn',
  });
});

test('a malformed krn.json names the field', () => {
  assert.throws(
    () => parseContractFile('{"tests":"x"}'),
    /unknown field "tests"/,
  );
  assert.throws(() => parseContractFile('{"related":"pytest"}'), /\{files\}/);
  assert.throws(
    () => parseContractFile('{"tracker":"jira"}'),
    /"krn" or "none"/,
  );
  assert.throws(() => parseContractFile('[]'), /object/);
});

test('the base is the repository default branch, not an assumed main', () => {
  const root = fixture({ 'go.mod': 'module x' }, 'master');
  assert.equal(resolveContract(root).contract.base, 'master');
});

test('related tests quote each path and fall back to the full suite', () => {
  const contract = {
    base: 'main',
    test: 'pytest',
    related: 'pytest {files}',
    tracker: 'none' as const,
  };
  assert.equal(
    relatedCommand(contract, ['tests/a b.py', "tests/it's.py"]),
    `pytest 'tests/a b.py' 'tests/it'\\''s.py'`,
  );
  assert.equal(relatedCommand(contract, []), 'pytest');
  assert.equal(
    relatedCommand({ base: 'main', test: 'pytest', tracker: 'none' }, ['x']),
    'pytest',
  );
});

test('krn repo contract prints JSON and exits 65 when no test command exists', () => {
  const cli = join(import.meta.dirname, '../../src/cli/main.ts');
  const ok = spawnSync(
    'node',
    [cli, 'repo', 'contract', '--root', fixture({ 'go.mod': '' })],
    { encoding: 'utf8' },
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).contract.test, 'go test ./...');
  const none = spawnSync(
    'node',
    [cli, 'repo', 'contract', '--root', fixture({ 'README.md': '' })],
    { encoding: 'utf8' },
  );
  assert.equal(none.status, 65);
  assert.equal(none.stdout, '');
  assert.match(none.stderr, /no test command/);
});

test('unittest, phpunit, nested modules and workspaces are detected with test and related', () => {
  const cases: [Record<string, string>, string, string, string | undefined][] =
    [
      [
        { 'tests/test_a.py': 'import unittest\n' },
        'python/unittest',
        'python -m unittest discover',
        'python -m unittest {files}',
      ],
      [
        { 'phpunit.xml': '<phpunit/>' },
        'php/phpunit',
        'vendor/bin/phpunit',
        'vendor/bin/phpunit {files}',
      ],
      [
        { 'composer.json': '{"require-dev":{"phpunit/phpunit":"^10"}}' },
        'php/phpunit',
        'vendor/bin/phpunit',
        'vendor/bin/phpunit {files}',
      ],
      [
        { 'services/go.mod': 'module x' },
        'go',
        'cd services && go test ./...',
        'cd services && go test ./...',
      ],
      [
        { 'core/Cargo.toml': '' },
        'rust',
        'cd core && cargo test',
        'cd core && cargo test',
      ],
      [
        {
          'package.json': '{"private":true}',
          'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
          'pnpm-lock.yaml': '',
        },
        'node/pnpm-workspace',
        'pnpm -r --if-present test',
        undefined,
      ],
      [
        {
          'package.json': JSON.stringify({
            workspaces: ['packages/*'],
            devDependencies: { vitest: '1' },
          }),
        },
        'node/npm-workspace',
        'npm test --workspaces --if-present',
        'npx vitest run {files}',
      ],
    ];
  for (const [files, stack, testCommand, related] of cases) {
    const resolved = resolveContract(fixture(files));
    assert.equal(resolved.stack, stack, stack);
    assert.equal(resolved.contract.test, testCommand, stack);
    assert.equal(resolved.contract.related, related, stack);
  }
});

test('an undetected stack prints the fields to write', () => {
  assert.throws(
    () => resolveContract(fixture({ 'README.md': '' })),
    (e: unknown) =>
      e instanceof ContractError &&
      /"test"/.test(e.message) &&
      /"related"/.test(e.message) &&
      /\{files\}/.test(e.message),
  );
});
