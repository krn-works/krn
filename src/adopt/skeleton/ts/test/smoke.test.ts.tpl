import assert from 'node:assert/strict';
import test from 'node:test';
import { add } from '../src/index.ts';

test('add sums two numbers', () => {
  assert.equal(add(1, 1), 2);
});
