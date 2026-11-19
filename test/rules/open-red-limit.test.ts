// The open-red limit refuses a new lane while too many open PRs have a red or missing Check.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkOpenRedLimit,
  type OpenPr,
  redOrMissing,
} from '../../src/cli/lane-open-red.ts';

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
  statusCheckRollup: [{ name: 'Check', conclusion: 'SUCCESS' }],
});

/** The open-red check with the plain `Check` as the required context, so no test asks GitHub. */
const checkWith = (read: () => OpenPr[] | undefined) =>
  checkOpenRedLimit('.', read, () => 'Check');

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
    () => withMax(undefined, () => checkWith(() => prs)),
    /open-red limit: 3 open PRs.*KRN_OPEN_RED_MAX.*#1, #2, #3/,
  );
});

test('two red or missing PRs pass; a green one never counts', () => {
  const prs = [red, missing(2), green(3), green(4)];
  withMax(undefined, () => checkWith(() => prs));
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
  withMax('1', () => checkWith(() => [rerun]));
});

test('KRN_OPEN_RED_MAX moves the limit', () => {
  assert.throws(() => withMax('1', () => checkWith(() => [red])), /maximum 1/);
  withMax('4', () => checkWith(() => [red, missing(2), missing(3)]));
});

test('an unreadable PR list passes', () => {
  withMax(undefined, () => checkWith(() => undefined));
});

const now = Date.now();
const stale = new Date(now - 3_600_000).toISOString();
const fresh = new Date(now - 60_000).toISOString();

test('only a failed Check and a stale PR with no run count; a pending Check and a fresh PR with no run do not', () => {
  const pendingAggregate: OpenPr = {
    number: 10,
    updatedAt: stale,
    statusCheckRollup: [
      { name: 'Check', status: 'IN_PROGRESS', conclusion: '' },
    ],
  };
  const pendingJobs: OpenPr = {
    number: 11,
    updatedAt: stale,
    statusCheckRollup: [
      { name: 'Test (12/13)', status: 'IN_PROGRESS', conclusion: '' },
      { name: 'Lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
  };
  const queued: OpenPr = {
    number: 12,
    updatedAt: stale,
    statusCheckRollup: [{ name: 'Check', status: 'QUEUED', conclusion: '' }],
  };
  const failed: OpenPr = {
    number: 13,
    updatedAt: stale,
    statusCheckRollup: [
      { name: 'Check', status: 'COMPLETED', conclusion: 'FAILURE' },
    ],
  };
  const noRunStale: OpenPr = {
    number: 14,
    updatedAt: stale,
    statusCheckRollup: [],
  };
  const noRunFresh: OpenPr = {
    number: 15,
    updatedAt: fresh,
    statusCheckRollup: [],
  };
  const prs = [
    pendingAggregate,
    pendingJobs,
    queued,
    failed,
    noRunStale,
    noRunFresh,
  ];
  assert.deepEqual(
    prs.filter((pr) => redOrMissing(pr, now)).map((pr) => pr.number),
    [13, 14],
  );
  assert.throws(
    () => withMax('2', () => checkWith(() => prs)),
    /2 open PRs.*#13, #14/,
  );
  withMax('3', () => checkWith(() => prs));
});

test('a red-by-design reusable-workflow Check beside no required Check is not red', () => {
  const pr: OpenPr = {
    number: 9,
    statusCheckRollup: [
      {
        name: 'expected-red / Check',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
      },
      { name: 'Lint', status: 'IN_PROGRESS' },
    ],
  };
  assert.equal(redOrMissing(pr), false);
  assert.equal(redOrMissing(pr, Date.now(), 'expected-red / Check'), true);
});
