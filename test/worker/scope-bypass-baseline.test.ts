import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup } from './scope-bypass-fixture.ts';

test('baseline ignored trees are skipped while new paths still undergo tiers on every turn', async (t) => {
  const s = await setup(t);
  // More than the per-turn limit already exists; it must never be descended.
  mkdirSync(join(s.repo, 'node_modules/dependency'), { recursive: true });
  for (let i = 0; i <= 10000; i++)
    writeFileSync(
      join(s.repo, 'node_modules/dependency', `${i}.js`),
      'existing',
    );
  mkdirSync(join(s.repo, '.krn/runs/other'), { recursive: true });
  writeFileSync(join(s.repo, '.krn/runs/other/AGENTS.md'), 'existing');
  assert.equal((await s.turn('ok').result).code, 0);
  const result = await s.turn('ignore AGENTS.md').result;
  assert.equal(result.code, 3, result.stderr);
  assert.ok(result.stderr.includes('AGENTS.md'), result.stderr);
});
