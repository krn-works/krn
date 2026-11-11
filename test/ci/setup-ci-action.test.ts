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
  // 1300 polls of 0.5s = 650s, above the installer's 60s + 3 x 180s + 15s bound.
  assert.match(action, /seq 1 1300/u);
  assert.match(action, /command -v bwrap/u);
  // A mirror outage falls back to the canonical archive.
  assert.match(action, /archive\.ubuntu\.com\/ubuntu\//u);
  // A cached .deb installs without the apt mirror.
  assert.match(action, /Cache the bubblewrap package/u);
  assert.match(action, /dpkg -i/u);
});

test('bubblewrap installs from the pinned ci-deps release without any Ubuntu archive', () => {
  // Every Ubuntu archive host was unresolvable from the runners (run 43052825847).
  assert.match(
    action,
    /releases\/download\/ci-deps\/bubblewrap_0\.9\.0-1ubuntu0\.3_amd64\.deb/u,
  );
  assert.match(
    action,
    /2461f1beee9cb04c8942739fe1a2b37e7b7c2a3d518f0779dc75f9245baa3094 {2}\$deb" \| sha256sum -c -/u,
  );
  assert.ok(
    action.indexOf('releases/download/ci-deps') <
      action.indexOf('for attempt in 1 2 3'),
    'the release fetch runs before any apt attempt',
  );
});

test('the background installer body holds no single quote that would end its bash -c string', () => {
  // Run 43055642486: an apostrophe in a comment closed the quote and every shard
  // failed with "$2: unbound variable".
  const body = /setsid nohup bash -c '\n([\s\S]*?)\n {8}' _ "\$status"/u.exec(
    action,
  )?.[1];
  assert.ok(body, 'the installer body is found');
  assert.doesNotMatch(body, /'/u);
});
