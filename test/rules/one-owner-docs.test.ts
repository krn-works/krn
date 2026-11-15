import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const program = new URL('../../docs/program/', import.meta.url);

// ADR 0024: plan.md is the one tracked plan every session starts from.
test('the program docs keep exactly one plan file, plan.md', () => {
  const plans = readdirSync(program).filter((name) =>
    /^plans?\.md$/iu.test(name),
  );
  assert.deepEqual(plans, ['plan.md']);
});

test('the delivery gate text has one owner and the other docs point to it', () => {
  for (const name of ['repository-workflow.md']) {
    assert.ok(existsSync(new URL(name, program)));
    const text = readFileSync(new URL(name, program), 'utf8');
    assert.doesNotMatch(text, /App `15368`/u, name);
    assert.match(text, /lead-rules\.md/u, name);
  }
});
