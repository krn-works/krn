import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './compaction-fixture.ts';

for (const [name, extra] of [
  ['the compaction item', {}],
  [
    'the deprecated thread/compacted',
    { CODEX_TEST_WORKER_COMPACTED_NOTIFICATION: '1' },
  ],
] as const)
  test(`a turn starts only after ${name} of its own thread`, async (t) => {
    const s = await setup(t);
    Object.assign(s.env, { CODEX_TEST_WORKER_SLOW_COMPACTION: '1', ...extra });
    assert.equal(
      (await s.turn('large', true, ['--timeout-min', '0.1'])).code,
      0,
    );
    const sent = await s.turn('ok');
    assert.equal(sent.code, 0, sent.stderr);
    assert.equal(s.json('rounds/002/metrics.json').compacted, true);
    const methods = s.requests().map((x) => x.method);
    assert.ok(
      methods.indexOf('thread/compact/start') <
        methods.lastIndexOf('turn/start'),
    );
  });
test('send --compact always compacts a small thread before its turn', async (t) => {
  const s = await setup(t);
  Object.assign(s.env, { CODEX_TEST_WORKER_SLOW_COMPACTION: '1' });
  assert.equal((await s.turn('ok', true)).code, 0);
  const sent = await s.turn('ok', false, ['--compact', 'always']);
  assert.equal(sent.code, 0, sent.stderr);
  assert.equal(s.json('rounds/002/metrics.json').compacted, true);
  assert.equal(
    s.requests().filter((x) => x.method === 'thread/compact/start').length,
    1,
  );
});
