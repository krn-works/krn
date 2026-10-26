import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const self = relative(root, fileURLToPath(import.meta.url));

test('retired tracker integration is absent from tracked Product inputs', () => {
  const result = spawnSync(
    'git',
    [
      'grep',
      '-inI',
      '-e',
      ['paper', 'clip'].join(''),
      '--',
      'src/',
      'scripts/',
      'test/',
      'spec/',
      'package.json',
      `:(exclude)${self}`,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout || result.stderr);
});
