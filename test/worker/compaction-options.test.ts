import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './compaction-fixture.ts';

test('send without --compact keeps a small thread uncompacted', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('ok', true)).code, 0);
  assert.equal((await s.turn('ok')).code, 0);
  assert.equal(s.json('rounds/002/metrics.json').compacted, false);
});
test('--compact is refused outside send', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('ok', true, ['--compact', 'always'])).code, 64);
  assert.equal((await s.turn('ok', true)).code, 0);
  assert.equal((await s.turn('ok', false, ['--compact', 'never'])).code, 64);
});
test('compaction counts against the round timeout', async (t) => {
  const s = await setup(t);
  Object.assign(s.env, {
    CODEX_TEST_WORKER_SLOW_COMPACTION: '1',
    CODEX_TEST_WORKER_COMPACT_ACK_MS: '3000',
  });
  assert.equal((await s.turn('ok', true, ['--timeout-min', '0.02'])).code, 0);
  const sent = await s.turn('ok', false, ['--compact', 'always']);
  assert.equal(sent.code, 124, sent.stderr);
  const methods = s.requests().map((x) => x.method);
  assert.equal(methods.filter((x) => x === 'turn/start').length, 1);
  // No turn started, so the timeout neither interrupts nor waits on one.
  assert.equal(methods.includes('turn/interrupt'), false);
  assert.equal(s.json('session.json').status, 'dead');
});
