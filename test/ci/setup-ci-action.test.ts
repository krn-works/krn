import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const action = await readFile(
  new URL('../../.github/actions/setup-ci/action.yml', import.meta.url),
  'utf8',
);
test('the bubblewrap install retries with a pause and its wait outlasts every attempt', () => {
  assert.match(action, /for attempt in 1 2 3; do/u);
  assert.match(action, /sleep \$\(\(attempt \* 5\)\)/u);
  // 1200 polls of 0.5s = 600s, above the installer's 3 x 180s + 15s bound.
  assert.match(action, /seq 1 1200/u);
  assert.match(action, /command -v bwrap/u);
  // A cached .deb installs without the apt mirror.
  assert.match(action, /Cache the bubblewrap package/u);
  assert.match(action, /dpkg -i/u);
});
