import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './report-outcome-fixture.ts';

test('partial-named exits 4', async (t) => {
  const s = await setup(t);
  const result = await s.turn('partial-named', true);
  assert.equal(result.code, 4, result.stderr);
  assert.match(result.stderr, /status: partial\nblocker: tests missing/);
});
test('report outcomes are visible on start and send', {
  concurrency: 6,
}, async (t) => {
  for (const [action, code, pattern] of [
    ['blocked-named', 4, /status: blocked\nblocker: npm test exit 1/],
    ['partial-empty', 4, /names no blocker.*\nstatus: partial/s],
    ['blocked-empty', 4, /names no blocker.*\nstatus: blocked/s],
    ['partial-blank', 4, /names no blocker/],
    ['blocked-blank', 4, /names no blocker/],
    ['done-clean', 0, /status: done/],
    ['done-failing', 4, /status: done\nfailing check: npm test exit 1/],
    ['ok', 0, /status: done/],
    ['scope-partial', 3, /scope violation/],
    ['invalid', 4, /status: none/],
  ] as const) {
    t.test(action, async (t) => {
      const s = await setup(t);
      for (const first of [true, false]) {
        if (action === 'scope-partial' && !first) break;
        const result = await s.turn(
          action,
          first,
          action === 'scope-partial' ? ['--allow', 'src/**'] : [],
        );
        assert.equal(result.code, code, result.stderr);
        assert.match(code ? result.stderr : result.stdout, pattern);
        if (action === 'ok' || action === 'done-clean')
          assert.doesNotMatch(result.stdout, /failing check/);
      }
    });
  }
});
