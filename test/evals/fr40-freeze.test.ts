import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
