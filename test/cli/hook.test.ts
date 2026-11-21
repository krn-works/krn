import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The receiver is the product binary itself: `bin/krn hook <name> [args]` runs the hook dispatcher.
const root = fileURLToPath(new URL('../..', import.meta.url));
const krn = fileURLToPath(new URL('../../bin/krn', import.meta.url));

function hook(args: string[], input: string, env: NodeJS.ProcessEnv = {}) {
  const { KRN_SESSION_CLASS, KRN_ROLE, KRN_SCOPE, KRN_TASK, ...rest } =
    process.env;
  return spawnSync(krn, ['hook', ...args], {
    cwd: root,
    input,
    encoding: 'utf8',
    env: { ...rest, ...env },
  });
}

test('krn hook stop forwards --related to the Stop gate', () => {
  const result = hook(['stop', '--related'], '');
  assert.equal(result.status, 0, result.stderr);
});

test('krn hook with an unknown hook name exits 64 naming the hooks', () => {
  const result = hook(['nope'], '');
  assert.equal(result.status, 64);
  assert.match(
    result.stderr,
    /krn hook <user-prompt\|session-start\|pre-tool\|post-tool\|model-switch\|stop\|subagent-stop\|session\|scope\|edit>/u,
  );
});
