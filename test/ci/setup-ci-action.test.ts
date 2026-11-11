import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const action = await readFile(
  new URL('../../.github/actions/setup-ci/action.yml', import.meta.url),
  'utf8',
);
test('the bubblewrap install retries with a pause and its wait outlasts every attempt', () => {
  assert.match(action, /for attempt in 1 2 3 4; do/u);
  assert.match(action, /sleep \$\(\(attempt \* 5\)\)/u);
  // 600 polls of 0.5s: longer than 4 attempts of the 90s install timeout.
  assert.match(action, /seq 1 600/u);
});
