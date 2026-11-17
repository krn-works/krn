import assert from 'node:assert/strict';
import test from 'node:test';
import { loadScaledTimeoutMs } from '../../scripts/lib/load-budget.ts';

test('an idle or lightly loaded host keeps the idle timeout', () => {
  assert.equal(loadScaledTimeoutMs(240_000, 0, 16), 240_000);
  assert.equal(loadScaledTimeoutMs(240_000, 12, 16), 240_000);
});

test('a host loaded past its cores stretches the timeout by the load per core', () => {
  assert.equal(loadScaledTimeoutMs(240_000, 32, 16), 480_000);
  assert.equal(loadScaledTimeoutMs(240_000, 100, 16), 1_500_000);
});

test('the stretch is capped and survives odd readings', () => {
  assert.equal(loadScaledTimeoutMs(100, 10_000, 16), 800);
  assert.equal(loadScaledTimeoutMs(100, Number.NaN, 16), 100);
  assert.equal(loadScaledTimeoutMs(100, 50, 0), 100);
});
