import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exec,
  failingFiles,
  unattributedSuiteFailure,
  validUnit,
} from '../../evals/d23/grade.ts';

test('a unit with no FAIL_TO_PASS test is invalid, as is one whose merge leaves a hidden test red', () => {
  assert.equal(validUnit([]), false);
  assert.equal(validUnit([true, false]), false);
  assert.equal(validUnit([true, true]), true);
});

test('a red suite that names no failing file is a failure; a green one or a named failure is not', () => {
  const crash =
    'node:internal/modules/esm/resolve\nError [ERR_MODULE_NOT_FOUND]: Cannot find module\n';
  assert.deepEqual(failingFiles(crash, '/w'), []);
  assert.equal(unattributedSuiteFailure(1, failingFiles(crash, '/w')), true);
  assert.equal(unattributedSuiteFailure(0, []), false);
  const tap = "not ok 1 - x\n  ---\n  location: '/w/test/a.test.ts:3:1'\n";
  assert.deepEqual(failingFiles(tap, '/w'), ['test/a.test.ts']);
  assert.equal(unattributedSuiteFailure(1, failingFiles(tap, '/w')), false);
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Polls until `pid` is gone, so a SIGKILL that has not been reaped yet does not read as a survivor. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && alive(pid); i++)
    await new Promise((r) => setTimeout(r, 20));
  return !alive(pid);
}

// Regression: a replay's node --test worker outlived its run and held a deleted run directory for days.
test('a replay command leaves no descendant behind when it ends or times out', async () => {
  const ended = await exec(
    'sh',
    ['-c', 'sleep 300 >/dev/null 2>&1 & echo $!'],
    process.cwd(),
  );
  assert.equal(ended.code, 0);
  assert.ok(
    await gone(Number(ended.out.trim())),
    'a child left running after the run ended',
  );
  const timed = await exec(
    'sh',
    ['-c', 'sleep 300 & echo $!; wait'],
    process.cwd(),
    300,
  );
  assert.ok(
    await gone(Number(timed.out.trim())),
    'a child left running after the timeout',
  );
});
