import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detectStack,
  POPULATION,
  type Row,
  renderTable,
} from '../scripts/adoption-census.ts';

test('stack detection names workspaces, wordpress, python and static repositories', () => {
  assert.equal(detectStack(['package.json', 'tsconfig.json']), 'ts');
  assert.equal(
    detectStack(['package.json'], '{"workspaces":["a"]}'),
    'npm workspaces',
  );
  assert.equal(
    detectStack(['composer.json', 'wp-cli.yml', 'package.json']),
    'npm+php/wordpress',
  );
  assert.equal(detectStack(['pyproject.toml']), 'python');
  assert.equal(detectStack(['index.html']), 'static/other');
});

test('the census population is fifteen distinct repositories', () => {
  assert.equal(POPULATION.length, 15);
  assert.equal(new Set(POPULATION).size, 15);
});

test('the table renders one row per repository with exits and escaped gaps', () => {
  const row: Row = {
    repo: 'a/b',
    head: 'abc1234',
    stack: 'ts',
    adopt: 64,
    standards: 0,
    verify: 1,
    test: 'none',
    gaps: 'adopt: x | y',
  };
  const table = renderTable([row]);
  assert.match(
    table,
    /\| a\/b \| abc1234 \| ts \| 64 \| 0 \| 1 \| none \| adopt: x \/ y \|/,
  );
});
