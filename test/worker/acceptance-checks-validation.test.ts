import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup } from './acceptance-fixture.ts';

test('8: invalid or start-only options refuse before state or spawn', async (t) => {
  for (const args of [
    Array.from({ length: 17 }, () => ['--check', 'exit 0']).flat(),
    ['--observer', '../x'],
    ['--observer', '/abs'],
    ['--check', 'x'.repeat(4097)],
    ['--check', ''],
    ['--observer', 'a/../b'],
  ]) {
    const s = await setup(t);
    const r = await s.turn('done-clean', true, args);
    assert.equal(r.code, 64, r.stderr);
    assert.equal(existsSync(join(s.run, 'session.json')), false);
    assert.equal(existsSync(s.env.CODEX_TEST_WORKER_LOG ?? ''), false);
  }
  const s = await setup(t);
  const r = await s.turn('done-clean', false, ['--check', 'x']);
  assert.equal(r.code, 64, r.stderr);
  assert.equal(existsSync(s.env.CODEX_TEST_WORKER_LOG ?? ''), false);
});
test('9: old sessions default lists and reports refuse canary', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('done-clean', true)).code, 0);
  const module = await import('../../src/worker/state.ts');
  assert.equal(typeof module.sessionSchema.parse, 'function');
  const old = s.json('session.json');
  delete old.checks;
  delete old.observers;
  assert.deepEqual(module.sessionSchema.parse(old).checks, []);
  assert.deepEqual(module.sessionSchema.parse(old).observers, []);
  const report = s.json('rounds/001/report.json');
  assert.equal(module.reportSchema.safeParse(report).success, true);
  assert.equal(
    module.reportSchema.safeParse({ ...report, canary: '' }).success,
    false,
  );
  assert.equal(module.acceptanceValueSchema.safeParse('a\0b').success, false);
  assert.equal(
    module.acceptanceValueSchema.safeParse('ą'.repeat(2049)).success,
    false,
  );
});
