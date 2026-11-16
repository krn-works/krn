// The schema-subset validator knows every keyword spec/schema/task.v1.json uses on `stack`:
// a task created with `--stack` failed the format contract check with "unsupported keyword
// minItems" and "uniqueItems" (t-y9gvftp).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validate } from './json-schema-subset.ts';

const schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../spec/schema/task.v1.json', import.meta.url)),
    'utf8',
  ),
) as { properties: { stack: Record<string, unknown> } };
const stack = schema.properties.stack;

test('a stack of distinct names conforms to the task schema', () => {
  assert.deepEqual(validate(stack, ['typescript']), []);
  assert.deepEqual(validate(stack, ['typescript', 'node']), []);
});

test('an empty or duplicated stack is refused', () => {
  assert.deepEqual(validate(stack, []), ['$: fewer than 1 items']);
  assert.deepEqual(validate(stack, ['node', 'node']), ['$: duplicate items']);
});
