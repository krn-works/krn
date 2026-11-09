import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './scope-bypass-fixture.ts';

test('worker-created ignores cannot hide forbidden paths or newly created ignored trees', {
  concurrency: 6,
}, async (t) => {
  for (const path of [
    'AGENTS.md',
    'nested/CLAUDE.md',
    'node_modules/AGENTS.md',
    '.krn/other/AGENTS.md',
  ]) {
    t.test(path, async (t) => {
      const s = await setup(t);
      const result = await s.turn(`ignore ${path}`).result;
      assert.equal(result.code, 3, result.stderr);
      assert.ok(result.stderr.includes(path), result.stderr);
    });
  }
});
