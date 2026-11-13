import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { check, LAYERS } from '../../scripts/boundaries.ts';

const freeze = fileURLToPath(
  new URL('../../evals/fr40/freeze.ts', import.meta.url),
);
const frozen = (name: string) =>
  readFileSync(new URL(`../../evals/fr40/${name}`, import.meta.url), 'utf8');
const run = (...args: string[]) =>
  spawnSync(process.execPath, [freeze, ...args], { encoding: 'utf8' });

test('the frozen FR-40 inputs match what the freeze regenerates', () => {
  const result = run('--check');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^drift=0$/mu);
});

test('the freeze refuses unknown arguments with exit 64 and writes nothing', () => {
  const names = ['manifest.json', 'scorer-imports.json', 'material.json'];
  const before = names.map(frozen);
  for (const args of [['--help'], [], ['--check', '--write']]) {
    const result = run(...args);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /usage: .*--check \| --write/u);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(names.map(frozen), before);
});

// The layer map as it stood before the freeze was regenerated for the repo-contract change.
const LAYERS_BEFORE_REGENERATION: Record<string, readonly string[]> = {
  ...LAYERS,
  adopt: ['task', 'repo'],
  brain: ['cli', 'evals/fr40/tasks.ts'],
};

test('regenerating the freeze for new layers leaves the core-imports score unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'fr40-core-'));
  mkdirSync(join(root, 'src/core'), { recursive: true });
  const cases = {
    clean: 'export const x = 1;\n',
    adopt: "import '../adopt/adopt.ts';\n",
    brain: "import '../brain/cli.ts';\n",
    cli: "import '../cli/main.ts';\n",
    repo: "import '../repo/contract.ts';\n",
  };
  for (const [name, source] of Object.entries(cases)) {
    writeFileSync(join(root, 'src/core', `${name}.ts`), source);
  }
  const scored = (layers: Record<string, readonly string[]>) =>
    check(root, layers)
      .filter((v) => v.file.startsWith('src/core/'))
      .map((v) => `${v.file}:${v.line} ${v.specifier}`);
  assert.deepEqual(scored(LAYERS), scored(LAYERS_BEFORE_REGENERATION));
  assert.equal(scored(LAYERS).length, 4);
  assert.deepEqual(LAYERS.core, []);
});
