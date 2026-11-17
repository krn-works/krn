import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EffectTotals } from '../../src/brain/exposures.ts';
import { showsNoEffect } from '../../src/brain/retire.ts';

const totals = (
  servedViolated: number,
  servedScoped: number,
  withheldViolated: number,
  withheldScoped: number,
): EffectTotals =>
  ({
    servedViolated,
    servedScoped,
    withheldViolated,
    withheldScoped,
  }) as EffectTotals;

test('a record with a plausible benefit on thin data is kept', () => {
  assert.equal(showsNoEffect(totals(1, 30, 2, 10)), false);
});

test('a large sample with no effect retires', () => {
  assert.equal(showsNoEffect(totals(150, 300, 50, 100)), true);
});
