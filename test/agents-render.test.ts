import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { render } from '../scripts/render-agents.ts';

test('AGENTS.md matches the rule registry renderer', async () => {
  assert.equal(
    await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8'),
    render(),
  );
});
