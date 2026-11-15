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
  'wordpress',
  'frontend',
];

function withRoot(marker: string, check: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'skill-set-'));
  try {
    writeFileSync(join(root, marker), '');
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a language stack gets the core skills only, never a per-language prose skill', () => {
  for (const marker of [
    'pyproject.toml',
    'composer.json',
    'Cargo.toml',
    'go.mod',
    'package.json',
  ])
    withRoot(marker, (root) =>
      assert.deepEqual(
        skillSet(root, everything),
        ['delivery-lead', 'delivery-retro'],
        marker,
      ),
    );
});

test('a WordPress repository gets the core skills plus the wordpress site skill, limited to what exists', () => {
  withRoot('wp-config.php', (root) => {
    assert.deepEqual(skillSet(root, everything), [
      'delivery-lead',
      'delivery-retro',
      'wordpress',
    ]);
    assert.deepEqual(skillSet(root, ['delivery-lead']), ['delivery-lead']);
  });
});
