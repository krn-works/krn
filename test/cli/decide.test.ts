import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// KRN-12: the real entry no longer knows `krn decide`; decisions live in the record store.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

test('krn decide is not a command; the decisions file answers instead', () => {
  const gone = spawnSync(process.execPath, [cli, 'decide', 'list'], {
    encoding: 'utf8',
  });
  assert.notEqual(gone.status, 0);
  assert.match(gone.stderr, /[Uu]nknown|usage/u);
  assert.doesNotMatch(gone.stdout, /deadline/u);
});
