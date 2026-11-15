import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { skillSet } from '../../src/adopt/skill-set.ts';

const everything = [
  'delivery-lead',
  'delivery-retro',
  'python',
  'php',
  'typescript',
  'go',
];

test('skill set is core plus the one stack skill of the repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-set-'));
  try {
    writeFileSync(join(root, 'pyproject.toml'), '');
    assert.deepEqual(skillSet(root, everything), [
      'delivery-lead',
      'delivery-retro',
      'python',
    ]);
    assert.deepEqual(skillSet(root, ['delivery-lead']), ['delivery-lead']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
