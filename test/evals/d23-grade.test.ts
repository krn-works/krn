import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
