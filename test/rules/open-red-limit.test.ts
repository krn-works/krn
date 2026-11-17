// The open-red limit refuses a new lane while too many open PRs have a red or missing Check.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkOpenRedLimit, type OpenPr } from '../../src/cli/lane-open-red.ts';

const red: OpenPr = {
  number: 1,
  statusCheckRollup: [{ name: 'Check', conclusion: 'FAILURE' }],
};
const missing = (number: number): OpenPr => ({
  number,
  statusCheckRollup: null,
});
const green = (number: number): OpenPr => ({
  number,
  statusCheckRollup: [{ name: 'ci / Check', conclusion: 'SUCCESS' }],
});

function withMax<T>(value: string | undefined, run: () => T): T {
  const before = process.env.KRN_OPEN_RED_MAX;
  if (value === undefined) delete process.env.KRN_OPEN_RED_MAX;
  else process.env.KRN_OPEN_RED_MAX = value;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.KRN_OPEN_RED_MAX;
    else process.env.KRN_OPEN_RED_MAX = before;
  }
}

test('three open PRs with a red or missing Check refuse a lane, naming the reason', () => {
  const prs = [red, missing(2), { ...red, number: 3 }, green(4)];
  assert.throws(
    () => withMax(undefined, () => checkOpenRedLimit('.', () => prs)),
    /open-red limit: 3 open PRs.*KRN_OPEN_RED_MAX.*#1, #2, #3/,
  );
});

test('two red or missing PRs pass; a green one never counts', () => {
  const prs = [red, missing(2), green(3), green(4)];
  withMax(undefined, () => checkOpenRedLimit('.', () => prs));
});

test('a newer green Check outranks an older red run', () => {
  const rerun: OpenPr = {
    number: 5,
    statusCheckRollup: [
      {
        name: 'Check',
        conclusion: 'FAILURE',
        startedAt: '2026-01-01T00:00:00Z',
      },
      {
        name: 'Check',
        conclusion: 'SUCCESS',
        startedAt: '2026-01-02T00:00:00Z',
      },
    ],
  };
  withMax('1', () => checkOpenRedLimit('.', () => [rerun]));
});

test('KRN_OPEN_RED_MAX moves the limit', () => {
  assert.throws(
    () => withMax('1', () => checkOpenRedLimit('.', () => [red])),
    /maximum 1/,
  );
  withMax('4', () =>
    checkOpenRedLimit('.', () => [red, missing(2), missing(3)]),
  );
});

test('an unreadable PR list passes', () => {
  withMax(undefined, () => checkOpenRedLimit('.', () => undefined));
});
