import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { alive, setup, until } from './hardening-fixture.ts';

test('missing, mismatched and malformed usage fail closed, interrupt, stop scope and never persist zero metrics', {
  concurrency: 6,
}, async (t) => {
  for (const action of [
    'no-usage',
    'wrong-thread-usage',
    'wrong-turn-usage',
    'bad-usage',
  ]) {
    t.test(action, async (t) => {
      const s = await setup(t);
      // Missing usage on a later turn must not reuse the preceding metrics.
      assert.equal((await s.turn('ok', true).result).code, 0);
      const state = s.json('session.json');
      const result = await s.turn(action).result;
      assert.equal(result.code, 65, result.stderr);
      assert.match(result.stderr, /usage/);
      assert.equal(existsSync(join(s.run, 'rounds/002/metrics.json')), false);
      await until(() =>
        s.requests().some((row) => row.method === 'turn/interrupt'),
      );
      await until(() => !alive(state.pid) && !alive(state.serverPid));
      assert.ok(
        s
          .rows(s.env.CODEX_TEST_WORKER_SCOPE_LOG)
          .some((row) => JSON.stringify(row).includes(state.unit)),
      );
      assert.equal((await s.turn('ok').result).code, 5);
    });
  }
  t.test(
    'first turn has no fabricated metrics or summary tokens',
    async (t) => {
      const s = await setup(t);
      const result = await s.turn('no-usage', true).result;
      assert.equal(result.code, 65, result.stderr);
      await until(() => existsSync(join(s.run, 'summary.json')));
      assert.equal(existsSync(join(s.run, 'rounds/001/metrics.json')), false);
      assert.equal('tokens' in s.json('summary.json'), false);
    },
  );
});
