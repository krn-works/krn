import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './session-fixture.ts';

test('approval request is declined and fails the round', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('approval', true)).code, 70);
  assert.deepEqual(s.requests().find((x) => x.id === 'approval').result, {
    decision: 'decline',
  });
});
test('compaction precedes next turn and fourth turn is refused', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('large', true)).code, 0);
  assert.equal((await s.turn('ok')).code, 0);
  assert.equal((await s.turn('ok')).code, 0);
  assert.equal((await s.turn('ok')).code, 5);
  const methods = s.requests().map((x) => x.method);
  assert.ok(
    methods.indexOf('thread/compact/start') < methods.lastIndexOf('turn/start'),
  );
  assert.equal(methods.filter((x) => x === 'turn/start').length, 3);
});
test('cumulative uncached budget refuses next send', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('budget', true)).code, 0);
  assert.equal((await s.turn('ok')).code, 5);
});
