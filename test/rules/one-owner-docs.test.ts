import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';

const program = new URL('../../docs/program/', import.meta.url);

// ADR 0024: plan.md is the one tracked plan every session starts from.
test('the program docs keep exactly one plan file, plan.md', () => {
  const plans = readdirSync(program).filter((name) =>
    /^plans?\.md$/iu.test(name),
  );
  assert.deepEqual(plans, ['plan.md']);
});
