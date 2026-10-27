import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyNodeTestOutput } from '../../src/flow/repository.ts';

function reporterOutput(report: {
  readonly testFailure: boolean;
  readonly errorCodes: readonly string[];
  readonly causeCodes: readonly string[];
  readonly skipped?: number;
}): string {
  return `KRN_NODE_TEST_REPORT:${JSON.stringify(report)}`;
}

test('assertion failures remain visible when other tests are skipped', () => {
  const output = reporterOutput({
    testFailure: true,
    errorCodes: ['ERR_TEST_FAILURE'],
    causeCodes: ['ERR_ASSERTION'],
    skipped: 1,
  });

  assert.equal(classifyNodeTestOutput(1, output), 'assertion');
});

test('direct assertion failures remain visible when other tests are skipped', () => {
  const output = reporterOutput({
    testFailure: true,
    errorCodes: ['ERR_ASSERTION'],
    causeCodes: [],
    skipped: 1,
  });

  assert.equal(classifyNodeTestOutput(1, output), 'assertion');
});

test('setup failures remain procedural when other tests are skipped', () => {
  const output = reporterOutput({
    testFailure: true,
    errorCodes: ['ERR_TEST_FAILURE'],
    causeCodes: ['ERR_MODULE_NOT_FOUND'],
    skipped: 1,
  });

  assert.equal(classifyNodeTestOutput(1, output), 'procedural');
});

test('unrecognized test failures remain failures when other tests are skipped', () => {
  const output = reporterOutput({
    testFailure: true,
    errorCodes: ['ERR_TEST_FAILURE'],
    causeCodes: [],
    skipped: 1,
  });

  assert.equal(classifyNodeTestOutput(1, output), 'other');
});

test('a genuine skip remains skipped on a nonzero run', () => {
  const output = reporterOutput({
    testFailure: false,
    errorCodes: [],
    causeCodes: [],
    skipped: 1,
  });

  assert.equal(classifyNodeTestOutput(1, output), 'skipped');
});

test('ordinary passing and failing runs keep their classifications', () => {
  assert.equal(
    classifyNodeTestOutput(
      0,
      reporterOutput({
        testFailure: false,
        errorCodes: [],
        causeCodes: [],
      }),
    ),
    'pass',
  );
  assert.equal(
    classifyNodeTestOutput(
      1,
      reporterOutput({
        testFailure: true,
        errorCodes: ['ERR_TEST_FAILURE'],
        causeCodes: [],
      }),
    ),
    'other',
  );
});
