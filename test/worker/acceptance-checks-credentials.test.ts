import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup } from './acceptance-fixture.ts';

test('12: a credential-like check or observer is refused, never stored altered', {
  concurrency: 6,
}, async (t) => {
  for (const args of [
    ['--check', 'printf sk-example'],
    ['--observer', 'sk-example.test.mjs'],
  ]) {
    t.test(args[0], async (t) => {
      const s = await setup(t);
      const r = await s.turn('done-clean', true, args);
      assert.equal(r.code, 64, r.stderr);
      assert.match(r.stderr, /looks like a credential/);
      assert.equal(existsSync(join(s.run, 'session.json')), false);
    });
  }
});
