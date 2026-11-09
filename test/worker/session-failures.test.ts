import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setup } from './session-fixture.ts';

test('timeout interrupts and stop reaps the owned server', async (t) => {
  const s = await setup(t);
  assert.equal(
    (await s.turn('hang', true, ['--timeout-min', '0.002'])).code,
    124,
  );
  assert.ok(s.requests().some((x) => x.method === 'turn/interrupt'));
  assert.equal((await s.command('stop')).code, 0);
  assert.throws(() =>
    process.kill(Number(readFileSync(s.env.CODEX_TEST_WORKER_PID, 'utf8')), 0),
  );
});
test('server crash fails promptly and next send refuses a dead thread', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('crash', true)).code, 75);
  assert.deepEqual(s.json('rounds/001/result.json').failure, {
    class: 'appServerExited',
    retryable: false,
    exit_status: 17,
    signal: null,
  });
  assert.equal((await s.turn('ok')).code, 5);
});
test('invalid reports and malformed protocol are bounded failures', {
  concurrency: 3,
}, async (t) => {
  for (const [action, code] of [
    ['invalid', 4],
    ['oversized', 4],
    ['malformed', 65],
    ['crlf', 65],
    ['bom', 65],
    ['line-limit', 65],
  ] as const)
    t.test(action, async (t) => {
      const s = await setup(t);
      assert.equal((await s.turn(action, true)).code, code);
    });
});
