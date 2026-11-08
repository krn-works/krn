import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './report-consistency-fixture.ts';

test('report cannot name an unchanged path', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('write a.txt', true)).code, 0);
  const r = await s.turn('lie-path');
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /report names unchanged path b.txt/);
  assert.match(r.stderr, /report omits changed path a.txt/);
});
test('report must include cumulative changes', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('write a.txt', true)).code, 0);
  const r = await s.turn('omit-path');
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /report omits changed path a.txt/);
});
