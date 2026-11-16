// krn adopt --init: git init and a test skeleton.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Failure } from '../brain/standards.ts';
import { GATE_KEYS, workflowGates } from './workflow-gates.ts';

export const INIT_STACKS = [
  'ts',
  'php',
  'python',
  'wp-plugin',
  'go',
  'rust',
] as const;
export type InitStack = (typeof INIT_STACKS)[number];

export interface InitReport {
  stack: InitStack;
  written: string[];
  /** Skeleton parts that could not be produced; the project is not born green until they are. */
  warnings: string[];
}

const BASE = 'main';

/** The package.json an existing project already has; unknown keys are kept when init adds a test script. */
export const manifestSchema = z.looseObject(
  { scripts: z.record(z.string(), z.string()).optional() },
  { error: 'package.json: scripts must map names to command strings' },
);

function git(root: string, args: string[]) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

/** The stack named by a manifest in the directory, undefined when none is there. */
export function detectInitStack(root: string): InitStack | undefined {
  if (existsSync(join(root, 'package.json'))) return 'ts';
  if (existsSync(join(root, 'go.mod'))) return 'go';
  if (existsSync(join(root, 'Cargo.toml'))) return 'rust';
  if (existsSync(join(root, 'composer.json')))
    return hasPluginHeader(root) ? 'wp-plugin' : 'php';
  for (const file of ['pyproject.toml', 'setup.py', 'requirements.txt'])
    if (existsSync(join(root, file))) return 'python';
  return undefined;
}

/** A top-level PHP file whose opening comment names a WordPress plugin. */
function hasPluginHeader(root: string): boolean {
  try {
    return readdirSync(root).some(
      (name) =>
        name.endsWith('.php') &&
        /^[ \t*@]*Plugin Name:/mu.test(
          readFileSync(join(root, name), 'utf8').slice(0, 8192),
        ),
    );
  } catch {
    return false;
  }
}

function pluginFile(name: string): string {
  return [
    '<?php',
    '/**',
    ` * Plugin Name: ${name}`,
    ' * Version: 0.1.0',
    ` * Text Domain: ${name}`,
    ' */',
    '',
    "if ( ! defined( 'ABSPATH' ) ) {",
    '    exit;',
    '}',
    '',
  ].join('\n');
}

function pluginReadme(name: string): string {
  return `=== ${name} ===\nStable tag: 0.1.0\n\n== Description ==\n${name}.\n`;
}

const smokeGo = [
  'package project',
  '',
  'import "testing"',
  '',
  'func TestAddSumsTwoNumbers(t *testing.T) {',
  '\tif Add(1, 1) != 2 {',
  '\t\tt.Fatal("Add is broken")',
  '\t}',
  '}',
  '',
].join('\n');

const libGo = [
  'package project',
  '',
  '// Add returns the sum of two numbers.',
  'func Add(a, b int) int {',
  '\treturn a + b',
  '}',
  '',
].join('\n');

const smokeRust = (crate: string) =>
  [
    `use ${crate}::add;`,
    '',
    '#[test]',
    'fn add_sums_two_numbers() {',
    '    assert_eq!(add(1, 1), 2);',
    '}',
    '',
  ].join('\n');

const libRust = [
  '/// The sum of two numbers.',
  'pub fn add(a: i32, b: i32) -> i32 {',
  '    a + b',
  '}',
  '',
].join('\n');

const libTs = [
  '/** The sum of two numbers. */',
  'export function add(a: number, b: number): number {',
  '  return a + b;',
  '}',
  '',
].join('\n');

const smokeTs = [
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  "import { add } from '../src/index.ts';",
  '',
  "test('add sums two numbers', () => {",
  '  assert.equal(add(1, 1), 2);',
  '});',
  '',
].join('\n');

const libPython = [
  'def add(a: int, b: int) -> int:',
  '    """The sum of two numbers."""',
  '    return a + b',
  '',
].join('\n');

const smokePython = [
  'import unittest',
  '',
  'from app import add',
  '',
  '',
  'class AddTest(unittest.TestCase):',
  '    def test_add_sums_two_numbers(self) -> None:',
  '        self.assertEqual(add(1, 1), 2)',
  '',
  '',
  "if __name__ == '__main__':",
  '    unittest.main()',
  '',
].join('\n');

const libPhp = [
  '<?php',
  '',
  'declare(strict_types=1);',
  '',
  'namespace Project;',
  '',
  'final class Math',
  '{',
  '    public static function add(int $a, int $b): int',
  '    {',
  '        return $a + $b;',
  '    }',
  '}',
  '',
].join('\n');

const smokePhp = [
  '<?php',
  '',
  'declare(strict_types=1);',
  '',
  'use PHPUnit\\Framework\\TestCase;',
  'use Project\\Math;',
  '',
  'final class SmokeTest extends TestCase',
  '{',
  '    public function testAddSumsTwoNumbers(): void',
  '    {',
  '        $this->assertSame(2, Math::add(1, 1));',
  '    }',
  '}',
  '',
].join('\n');

const phpunitXml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<phpunit colors="false" bootstrap="vendor/autoload.php">',
  '  <testsuites>',
  '    <testsuite name="project">',
  '      <directory>tests</directory>',
  '    </testsuite>',
  '  </testsuites>',
  '</phpunit>',
  '',
].join('\n');

const phpstanNeon =
  'parameters:\n  level: 6\n  paths:\n    - src\n    - tests\n';

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readme(name: string, command: string): string {
  return `# ${name}\n\nRun the tests with \`${command}\`.\n`;
}

function workflow(setup: string[], runs: string[]): string {
  return [
    'name: CI',
    '',
    'on:',
    '  push:',
    `    branches: [${BASE}]`,
    '  pull_request:',
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    ...setup,
    ...runs.map((run) => `      - run: ${run}`),
    '',
  ].join('\n');
}

/** What a CI workflow runs when the project needs more than the skeleton: `install`, `lint` and `typecheck` before `test`. */
export interface CiCommands {
  install?: string | undefined;
  lint?: string | undefined;
  typecheck?: string | undefined;
  test?: string | undefined;
}

/** The commands the contract of a skeleton records and its CI runs, one per gate. */
export interface InitGates {
  install?: string;
  lint: string;
  typecheck: string;
  test: string;
}

const GATES: Record<InitStack, InitGates> = {
  ts: {
    install: 'npm ci',
    lint: 'npm run lint',
    typecheck: 'npm run typecheck',
    test: 'npm test',
  },
  go: {
    install:
      'go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.1.6',
    lint: '$(go env GOPATH)/bin/golangci-lint run',
    typecheck: 'go vet ./...',
    test: 'go test ./...',
  },
  rust: {
    lint: 'cargo fmt --check && cargo clippy --all-targets -- -D warnings',
    typecheck: 'cargo check --all-targets',
    test: 'cargo test',
  },
  python: {
    install:
      'python3 -m venv .venv && .venv/bin/python -m pip install -r requirements-dev.txt',
    lint: '.venv/bin/ruff check .',
    typecheck: '.venv/bin/mypy .',
    test: 'python -m unittest discover -s tests -t .',
  },
  php: {
    install: 'composer install --no-interaction',
    lint: 'composer run lint',
    typecheck: 'composer run typecheck',
    test: 'make test',
  },
  'wp-plugin': {
    install: 'composer install --no-interaction',
    lint: 'composer run lint',
    typecheck: 'composer run typecheck',
    test: 'make test',
  },
};

/** The gate commands a stack skeleton installs tools for. */
export function initGates(stack: InitStack): InitGates {
  return GATES[stack];
}

/**
 * The CI workflow a stack's skeleton carries: one job running every gate command the skeleton installs a tool for,
 * minus the gates in `omit` that another workflow of the repository already runs.
 */
export function ciWorkflow(
  stack: InitStack,
  commands: CiCommands = {},
  gates = false,
  omit: readonly ('lint' | 'typecheck' | 'test')[] = [],
): string {
  const own = gates ? GATES[stack] : undefined;
  const install = commands.install ?? own?.install;
  const kept = (key: 'lint' | 'typecheck' | 'test', run: string | undefined) =>
    omit.includes(key) ? undefined : run;
  const lint = kept('lint', commands.lint ?? own?.lint);
  const typecheck = kept('typecheck', commands.typecheck ?? own?.typecheck);
  const test = kept('test', commands.test ?? own?.test ?? defaultTest(stack));
  const runs = [install, lint, typecheck, test].filter(
    (run): run is string => run !== undefined,
  );
  if (stack === 'ts')
    return workflow(
      [
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          node-version: 24',
      ],
      runs,
    );
  if (stack === 'php' || stack === 'wp-plugin') return workflow([], runs);
  if (stack === 'go')
    return workflow(
      [
        '      - uses: actions/setup-go@v5',
        '        with:',
        '          go-version-file: go.mod',
      ],
      runs,
    );
  if (stack === 'rust') return workflow([], runs);
  return workflow(
    [
      '      - uses: actions/setup-python@v5',
      '        with:',
      "          python-version: '3.12'",
    ],
    runs,
  );
}

function defaultTest(stack: InitStack): string {
  if (stack === 'ts') return 'npm test';
  if (stack === 'php' || stack === 'wp-plugin')
    return 'composer install --no-interaction && make test';
  if (stack === 'go') return 'go test ./...';
  if (stack === 'rust')
    return 'cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test';
  return 'python -m unittest discover -s tests';
}

function skeleton(root: string, stack: InitStack): Record<string, string> {
  const name =
    root
      .split('/')
      .filter(Boolean)
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9-]/gu, '-') || 'project';
  const ci = '.github/workflows/ci.yml';
  const workflowText = ciWorkflow(stack, {}, true);
  if (stack === 'ts')
    return {
      'package.json': json({
        name,
        private: true,
        type: 'module',
        scripts: {
          test: 'node --test',
          lint: 'biome check .',
          typecheck: 'tsc --noEmit',
        },
        devDependencies: {
          '@biomejs/biome': '2.6.8',
          '@types/node': '24.6.2',
          typescript: '7.0.2',
        },
      }),
      'tsconfig.json': json({
        compilerOptions: {
          target: 'es2022',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          skipLibCheck: true,
          types: ['node'],
        },
        include: ['src', 'test'],
      }).replace(
        /\[\s+((?:"[^"]*",?\s+)+)\]/gu,
        (_, items: string) => `[${items.trim().replace(/,\s+/gu, ', ')}]`,
      ),
      'biome.json': json({
        files: {
          includes: [
            '**',
            '!package-lock.json',
            '!.agents',
            '!.claude',
            '!.krn',
            '!tasks',
            '!krn.json',
          ],
        },
        formatter: { indentStyle: 'space' },
        javascript: { formatter: { quoteStyle: 'single' } },
        linter: { rules: { nursery: { noFloatingPromises: 'error' } } },
      }),
      '.gitignore': 'node_modules/\n',
      'README.md': readme(name, 'npm test'),
      'src/index.ts': libTs,
      'test/smoke.test.ts': smokeTs,
      [ci]: workflowText,
    };
  if (stack === 'go')
    return {
      'go.mod': `module example.com/${name}\n\ngo 1.22\n`,
      'project.go': libGo,
      [`${name}_test.go`]: smokeGo,
      '.golangci.yml': 'version: "2"\n',
      '.gitignore': 'bin/\n',
      'README.md': readme(name, 'go test ./...'),
      [ci]: workflowText,
    };
  if (stack === 'rust') {
    const crate = name.replace(/-/gu, '_');
    return {
      'Cargo.toml': `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\nrust-version = "1.74"\n`,
      // The lockfile of a package with no dependencies, written by hand: cargo needs no toolchain here.
      'Cargo.lock': `# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 3\n\n[[package]]\nname = "${name}"\nversion = "0.1.0"\n`,
      'src/lib.rs': libRust,
      'tests/smoke.rs': smokeRust(crate),
      '.gitignore': 'target/\n',
      'README.md': readme(name, 'cargo test'),
      [ci]: workflowText,
    };
  }
  if (stack === 'php' || stack === 'wp-plugin')
    return {
      ...(stack === 'wp-plugin'
        ? {
            [`${name}.php`]: pluginFile(name),
            'readme.txt': pluginReadme(name),
          }
        : {}),
      'composer.json': json({
        name: `project/${name}`,
        autoload: { 'psr-4': { 'Project\\': 'src/' } },
        'require-dev': { 'phpunit/phpunit': '^11', 'phpstan/phpstan': '^2' },
        scripts: {
          test: 'vendor/bin/phpunit',
          lint: "find src tests -name '*.php' -print0 | xargs -0 -n1 php -l",
          typecheck: 'vendor/bin/phpstan analyse --no-progress',
        },
      }),
      'phpunit.xml': phpunitXml,
      'phpstan.neon': phpstanNeon,
      '.gitignore': 'vendor/\n',
      'README.md': readme(name, 'make test'),
      Makefile: 'test:\n\tvendor/bin/phpunit\n',
      'src/Math.php': libPhp,
      'tests/SmokeTest.php': smokePhp,
      [ci]: workflowText,
    };
  return {
    'app.py': libPython,
    'tests/__init__.py': '',
    'tests/test_smoke.py': smokePython,
    'requirements.txt': '# runtime dependencies, one per line\n',
    'requirements-dev.txt': 'mypy==1.16.0\nruff==0.12.0\n',
    'pyproject.toml': `[tool.ruff]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n`,
    '.gitignore': '__pycache__/\n.venv/\nvenv/\n.mypy_cache/\n.ruff_cache/\n',
    'README.md': readme(name, GATES.python.test),
    [ci]: workflowText,
  };
}

/** The test command the adoption contract records for a skeleton that detection cannot name. */
export function initTestCommand(stack: InitStack): string | undefined {
  if (stack === 'go') return 'go test ./...';
  return stack === 'python' ? GATES.python.test : undefined;
}

/** The install command a fresh checkout needs before its tests run. */
export function initInstallCommand(stack: InitStack): string | undefined {
  if (stack === 'php' || stack === 'wp-plugin') return 'composer install';
  return stack === 'python' ? GATES.python.install : undefined;
}

/**
 * git init on `main`, then the missing files of a minimal real test for the stack, committed so the
 * canary and lane worktrees have a base. Throws on a repository with commits and on a directory
 * whose stack is neither detected nor named.
 */
export function initDirectory(root: string, named?: string): InitReport {
  if (
    named !== undefined &&
    !(INIT_STACKS as readonly string[]).includes(named)
  )
    throw new Error(`--stack takes ${INIT_STACKS.join('|')}, not ${named}`);
  if (existsSync(join(root, '.git'))) {
    if (git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).status === 0)
      throw new Error(
        `${root} is already a git repository with commits; run plain \`krn adopt ${root}\``,
      );
  }
  const stack = (named as InitStack | undefined) ?? detectInitStack(root);
  if (stack === undefined)
    throw new Error(
      `no stack detected in ${root}; pass --stack ${INIT_STACKS.join('|')}`,
    );
  mkdirSync(root, { recursive: true });
  const written: string[] = [];
  const created = git(root, ['init', '-q', '-b', BASE]);
  if (created.status !== 0)
    throw new Error(`git init failed: ${created.stderr}`);
  for (const [file, text] of Object.entries(skeleton(root, stack))) {
    const path = join(root, file);
    if (existsSync(path)) {
      if (file !== 'package.json') continue;
      const manifest = manifestSchema.parse(
        JSON.parse(readFileSync(path, 'utf8')),
      );
      if (manifest.scripts?.test !== undefined) continue;
      manifest.scripts = { ...manifest.scripts, test: 'node --test' };
      writeFileSync(path, json(manifest));
      written.push(file);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    written.push(file);
  }
  const warnings: string[] = [];
  if (
    (stack === 'php' || stack === 'wp-plugin') &&
    !existsSync(join(root, 'composer.lock'))
  ) {
    const locked = spawnSync(
      'composer',
      ['update', '--no-install', '--no-interaction', '--no-scripts'],
      { cwd: root, encoding: 'utf8' },
    );
    if (locked.status === 0) written.push('composer.lock');
    else
      warnings.push(
        `composer.lock not written (composer update exited ${locked.status ?? 'without a status'}): run \`composer update\` and commit it`,
      );
  }
  if (stack === 'ts' && !existsSync(join(root, 'package-lock.json'))) {
    const locked = spawnSync(
      'npm',
      [
        'install',
        '--package-lock-only',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    if (locked.status === 0) written.push('package-lock.json');
    else
      warnings.push(
        `package-lock.json not written (npm exited ${locked.status ?? 'without a status'}): run \`npm install\` and commit it`,
      );
  }
  const configured = git(root, ['config', 'user.name']).stdout.trim() !== '';
  const identity = configured
    ? []
    : ['-c', 'user.name=krn', '-c', 'user.email=krn@localhost'];
  git(root, ['add', '-A']);
  const commit = git(root, [
    ...identity,
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'chore: test skeleton',
  ]);
  if (commit.status !== 0)
    throw new Error(`initial commit failed: ${commit.stderr}`);
  return { stack, written, warnings };
}

// Host-applied remediation: the two failing standards a sandboxed lane cannot finish (it cannot
// create .github/workflows or a lockfile) are written here by the host, from the init skeletons.
export interface HostRemediation {
  /** Files the host wrote. */
  written: string[];
  /** Standards the host tried and could not fix, with the reason; they stay failing. */
  unfixed: string[];
}

const CI_STANDARD = 's-gate-in-ci';
const LOCKFILE_STANDARD = 's-lockfile-committed';

/** The commands an existing project's CI needs besides the skeleton test command. */
function commandsFor(root: string, stack: InitStack): CiCommands {
  const contract = contractCommands(root);
  if (contract.test !== undefined) return contract;
  if (stack === 'ts') {
    const locked = existsSync(join(root, 'package-lock.json'));
    return {
      install: locked ? 'npm ci' : 'npm install',
      test: scriptDefined(root, 'test') ? 'npm test' : undefined,
    };
  }
  if (stack === 'python')
    return {
      install: existsSync(join(root, 'requirements.txt'))
        ? 'python -m pip install -r requirements.txt'
        : undefined,
      test: existsSync(join(root, 'tests'))
        ? 'python -m unittest discover -s tests'
        : undefined,
    };
  return {};
}

/** The install and test commands krn.json records, which adopt detected from the repository. */
function contractCommands(root: string): CiCommands {
  try {
    const body: unknown = JSON.parse(
      readFileSync(join(root, 'krn.json'), 'utf8'),
    );
    const read = (key: string) => {
      const value = (body as Record<string, unknown>)[key];
      return typeof value === 'string' && value !== '' ? value : undefined;
    };
    // A vacuous contract records a placeholder that only fails: the workflow then runs the stack's own
    // test command, which the first task delivers, so the CI standard needs no later workflow edit.
    const vacuous = (body as Record<string, unknown>).vacuous === true;
    return {
      install: read('install'),
      lint: read('lint'),
      typecheck: read('typecheck'),
      test: vacuous ? undefined : read('test'),
    };
  } catch {
    return {};
  }
}

function scriptDefined(root: string, name: string): boolean {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    );
    const scripts = (manifest as { scripts?: Record<string, unknown> }).scripts;
    return typeof scripts?.[name] === 'string';
  } catch {
    return false;
  }
}

/** Writes the CI workflow, or says why none was written. */
function writeCi(root: string): { file: string } | { reason: string } {
  const stack = detectInitStack(root);
  if (stack === undefined)
    return { reason: 'no stack detected to write a workflow for' };
  // A ci.yml of the repository's own keeps running; the call that proves tests goes beside it.
  const file = existsSync(join(root, '.github/workflows/ci.yml'))
    ? '.github/workflows/krn-ci.yml'
    : '.github/workflows/ci.yml';
  if (existsSync(join(root, file))) return { reason: `${file} already exists` };
  // Fill gaps, never duplicate: a contract gate another workflow already runs gets no step here.
  const contract = contractCommands(root);
  const gates = workflowGates(root, contract);
  const omit = GATE_KEYS.filter((key) => (gates.runBy[key]?.length ?? 0) > 0);
  if (omit.length > 0 && gates.missing.length === 0)
    return {
      reason: `every contract gate already runs in ${[...new Set(Object.values(gates.runBy).flat())].join(', ')}`,
    };
  const commands = {
    lint: contract.lint,
    typecheck: contract.typecheck,
    ...commandsFor(root, stack),
  };
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), ciWorkflow(stack, commands, false, omit));
  return { file };
}

/** Runs npm's lockfile-only install in `root`, so the lockfile follows package.json; throws npm's last line on failure. */
export function syncLockfile(root: string): void {
  const locked = spawnSync(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (locked.status !== 0)
    throw new Error(
      `npm install --package-lock-only exited ${locked.status ?? 'without a status'}: ${(locked.stderr || locked.stdout).trim().split('\n').pop()}`,
    );
}

function writeLockfile(root: string): string | undefined {
  if (!existsSync(join(root, 'package.json'))) return undefined;
  if (existsSync(join(root, 'package-lock.json'))) return undefined;
  syncLockfile(root);
  return 'package-lock.json';
}

/**
 * Writes the CI workflow of a failing `s-gate-in-ci` and the lockfile of a failing
 * `s-lockfile-committed` into the working tree. Nothing is committed or pushed: the files are the
 * adopter's to review, and a refused workflow push is a decide record at ship, not a lane BLOCKER.
 */
export function remediateHost(
  root: string,
  failures: readonly Failure[],
): HostRemediation {
  const result: HostRemediation = { written: [], unfixed: [] };
  const failing = new Set(failures.map((failure) => failure.id));
  if (failing.has(LOCKFILE_STANDARD)) {
    try {
      const file = writeLockfile(root);
      if (file !== undefined) result.written.push(file);
    } catch (error) {
      result.unfixed.push(`${LOCKFILE_STANDARD}: ${(error as Error).message}`);
    }
  }
  if (failing.has(CI_STANDARD)) {
    const ci = writeCi(root);
    if ('reason' in ci) result.unfixed.push(`${CI_STANDARD}: ${ci.reason}`);
    else result.written.push(ci.file);
  }
  // The lockfile standard reads `git ls-files`: a written file counts once it is staged.
  if (result.written.length > 0)
    spawnSync('git', ['add', '--', ...result.written], { cwd: root });
  return result;
}
