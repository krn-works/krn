// krn adopt --init: git init and a test skeleton.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const INIT_STACKS = ['ts', 'php', 'python'] as const;
export type InitStack = (typeof INIT_STACKS)[number];

export interface InitReport {
  stack: InitStack;
  written: string[];
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
  if (existsSync(join(root, 'composer.json'))) return 'php';
  for (const file of ['pyproject.toml', 'setup.py', 'requirements.txt'])
    if (existsSync(join(root, file))) return 'python';
  return undefined;
}

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
      'biome.json': '{}\n',
      '.gitignore': 'node_modules/\n',
      'README.md': readme(name, 'npm test'),
      'test/smoke.test.ts': smokeTs,
      [ci]: workflow(
        [
          '      - uses: actions/setup-node@v4',
          '        with:',
          '          node-version: 24',
        ],
        'npm test',
      ),
    };
  if (stack === 'php')
    return {
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
      [ci]: workflow([], 'composer install --no-interaction && make test'),
    };
  return {
    'tests/test_smoke.py': smokePython,
    'requirements.txt': '# runtime dependencies, one per line\n',
    'pyproject.toml': `[tool.ruff]\nline-length = 100\n`,
    '.gitignore': '__pycache__/\n.venv/\nvenv/\n',
    'README.md': readme(name, 'python -m unittest discover -s tests'),
    [ci]: workflow(
      [
        '      - uses: actions/setup-python@v5',
        '        with:',
        "          python-version: '3.12'",
      ],
      'python -m unittest discover -s tests',
    ),
  };
}

/** The test command the adoption contract records for a skeleton that detection cannot name. */
export function initTestCommand(stack: InitStack): string | undefined {
  return stack === 'python'
    ? 'python -m unittest discover -s tests'
    : undefined;
}

/** The install command a fresh checkout needs before its tests run. */
export function initInstallCommand(stack: InitStack): string | undefined {
  return stack === 'php' ? 'composer install' : undefined;
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
  return { stack, written };
}
