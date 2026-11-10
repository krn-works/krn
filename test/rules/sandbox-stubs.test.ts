import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

// The harness sandbox mounts empty placeholders over write-denied paths
// (.env*, .npmrc, lockfiles, ...); a sandboxed `git add -A` commits them,
// as PR 565 did. Only captured empty output under a fixtures directory may
// be an empty tracked file.
test('no tracked file is an empty sandbox placeholder', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  const empty = tracked.filter((path) => {
    if (/(^|\/)fixtures\//.test(path)) return false;
    try {
      return statSync(join(root, path)).size === 0;
    } catch {
      return false;
    }
  });
  assert.deepEqual(empty, []);
});
