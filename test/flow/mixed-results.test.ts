import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyNodeTestOutput } from '../../src/flow/repository.ts';

const report = (
  testFailure: boolean,
  errorCodes: string[],
  causeCodes: string[],
  skipped?: number,
): string =>
  `KRN_NODE_TEST_REPORT:${JSON.stringify({ testFailure, errorCodes, causeCodes, skipped })}`;

const cases: [string, number, string, string][] = [
  [
    'assertion beside a skip',
    1,
    report(true, ['ERR_TEST_FAILURE'], ['ERR_ASSERTION'], 1),
    'assertion',
  ],
  [
    'direct assertion beside a skip',
    1,
    report(true, ['ERR_ASSERTION'], [], 1),
    'assertion',
  ],
  [
    'setup failure beside a skip',
    1,
    report(true, ['ERR_TEST_FAILURE'], ['ERR_MODULE_NOT_FOUND'], 1),
    'procedural',
  ],
  [
    'unrecognized failure beside a skip',
    1,
    report(true, ['ERR_TEST_FAILURE'], [], 1),
    'other',
  ],
  ['genuine skip on a nonzero run', 1, report(false, [], [], 1), 'skipped'],
  ['passing run', 0, report(false, [], []), 'pass'],
  ['failing run', 1, report(true, ['ERR_TEST_FAILURE'], []), 'other'],
];

for (const [name, code, output, expected] of cases)
  test(`classifies ${name}`, () =>
    assert.equal(classifyNodeTestOutput(code, output), expected));
