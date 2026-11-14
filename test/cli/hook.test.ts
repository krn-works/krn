import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The receiver is the product binary itself: `bin/krn hook <name> [args]` runs src/hook/<name>.ts.
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

test('krn hook scope refuses a worker write to tracker state outside its Scope', () => {
  const payload = JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: 'tasks/t-x.json' },
  });
  const refused = hook(['scope'], payload, {
    KRN_ROLE: 'worker',
    KRN_SCOPE: 'src/',
  });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /tasks\/t-x\.json is tracker state/u);
  assert.equal(hook(['scope'], payload).status, 0);
});

test('krn hook with an unknown hook name exits 64 naming the hooks', () => {
  const result = hook(['nope'], '');
  assert.equal(result.status, 64);
  assert.match(result.stderr, /krn hook <stop\|scope\|stash>/u);
});
