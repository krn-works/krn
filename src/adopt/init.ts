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
  'func TestProjectTestCommandRuns(t *testing.T) {',
  '\tif 1+1 != 2 {',
  '\t\tt.Fatal("arithmetic is broken")',
  '\t}',
  '}',
  '',
].join('\n');

const smokeRust = [
  '#[test]',
  'fn project_test_command_runs() {',
  '    assert_eq!(1 + 1, 2);',
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

const smokeTs = [
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  '',
  "test('the project test command runs', () => {",
  '  assert.equal(1 + 1, 2);',
  '});',
  '',
].join('\n');

const smokePython = [
  'import unittest',
  '',
  '',
  'class Smoke(unittest.TestCase):',
  '    def test_project_test_command_runs(self):',
  '        self.assertEqual(1 + 1, 2)',
  '',
  '',
  "if __name__ == '__main__':",
  '    unittest.main()',
  '',
].join('\n');

const smokePhp = [
  '<?php',
  '',
  'use PHPUnit\\Framework\\TestCase;',
  '',
  'final class SmokeTest extends TestCase',
  '{',
  '    public function testProjectTestCommandRuns(): void',
  '    {',
  '        $this->assertSame(2, 1 + 1);',
  '    }',
  '}',
  '',
].join('\n');

const phpunitXml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<phpunit colors="false">',
  '  <testsuites>',
  '    <testsuite name="project">',
  '      <directory>tests</directory>',
  '    </testsuite>',
  '  </testsuites>',
  '</phpunit>',
  '',
].join('\n');

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readme(name: string, command: string): string {
  return `# ${name}\n\nRun the tests with \`${command}\`.\n`;
}

function workflow(setup: string[], run: string): string {
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
    `      - run: ${run}`,
    '',
  ].join('\n');
}

/** What a CI workflow runs when the project needs more than the skeleton: `install` before `test`. */
export interface CiCommands {
  install?: string | undefined;
  test?: string | undefined;
}

/** The CI workflow a stack's skeleton carries: one job running the stack's test command on every pull request. */
export function ciWorkflow(
  stack: InitStack,
  commands: CiCommands = {},
): string {
  const run = (test: string) =>
    commands.install === undefined
      ? (commands.test ?? test)
      : `${commands.install} && ${commands.test ?? test}`;
  if (stack === 'ts')
    return workflow(
      [
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          node-version: 24',
      ],
      run('npm test'),
    );
  if (stack === 'php' || stack === 'wp-plugin')
    return workflow([], run('composer install --no-interaction && make test'));
  if (stack === 'go')
    return workflow(
      [
        '      - uses: actions/setup-go@v5',
        '        with:',
        '          go-version-file: go.mod',
      ],
      run('go test ./...'),
    );
  if (stack === 'rust')
    return workflow(
      [],
      run(
        'cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test',
      ),
    );
  return workflow(
    [
      '      - uses: actions/setup-python@v5',
      '        with:',
      "          python-version: '3.12'",
    ],
    run('python -m unittest discover -s tests'),
  );
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
  if (stack === 'ts')
    return {
      'package.json': json({
        name,
        private: true,
        type: 'module',
        scripts: { test: 'node --test' },
      }),
      'package-lock.json': json({
        name,
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name } },
      }),
      'biome.json': json({
        linter: { rules: { nursery: { noFloatingPromises: 'error' } } },
      }),
      '.gitignore': 'node_modules/\n',
      'README.md': readme(name, 'npm test'),
      'test/smoke.test.ts': smokeTs,
      [ci]: ciWorkflow(stack),
    };
  if (stack === 'go')
    return {
      'go.mod': `module example.com/${name}\n\ngo 1.22\n`,
      [`${name}_test.go`]: smokeGo,
      '.golangci.yml': 'version: "2"\n',
      '.gitignore': 'bin/\n',
      'README.md': readme(name, 'go test ./...'),
      [ci]: ciWorkflow(stack),
    };
  if (stack === 'rust')
    return {
      'Cargo.toml': `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\nrust-version = "1.74"\n`,
      // The lockfile of a package with no dependencies, written by hand: cargo needs no toolchain here.
      'Cargo.lock': `# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 3\n\n[[package]]\nname = "${name}"\nversion = "0.1.0"\n`,
      'src/lib.rs': libRust,
      'tests/smoke.rs': smokeRust,
      '.gitignore': 'target/\n',
      'README.md': readme(name, 'cargo test'),
      [ci]: ciWorkflow(stack),
    };
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
        'require-dev': { 'phpunit/phpunit': '^11' },
        scripts: {
          test: 'vendor/bin/phpunit',
          lint: 'php -l tests/SmokeTest.php',
        },
      }),
      'phpunit.xml': phpunitXml,
      '.prettierrc': '{}\n',
      '.gitignore': 'vendor/\n',
      'README.md': readme(name, 'make test'),
      Makefile: 'test:\n\tvendor/bin/phpunit\n',
      'tests/SmokeTest.php': smokePhp,
      [ci]: ciWorkflow(stack),
    };
  return {
    'tests/test_smoke.py': smokePython,
    'requirements.txt': '# runtime dependencies, one per line\n',
    'pyproject.toml': `[tool.ruff]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n`,
    '.gitignore': '__pycache__/\n.venv/\nvenv/\n',
    'README.md': readme(name, 'python -m unittest discover -s tests'),
    [ci]: ciWorkflow(stack),
  };
}

/** The test command the adoption contract records for a skeleton that detection cannot name. */
export function initTestCommand(stack: InitStack): string | undefined {
  if (stack === 'go') return 'go test ./...';
  return stack === 'python'
    ? 'python -m unittest discover -s tests'
    : undefined;
}

/** The install command a fresh checkout needs before its tests run. */
export function initInstallCommand(stack: InitStack): string | undefined {
  return stack === 'php' || stack === 'wp-plugin'
    ? 'composer install'
    : undefined;
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
