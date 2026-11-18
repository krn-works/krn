import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { verifyGaps } from '../../src/adopt/verify.ts';
import { REQUIRED_CHECK_APP_ID } from '../../src/repo/ci-admission-contract.ts';
import * as requiredCheck from '../../src/repo/required-check.ts';
import {
  CHECK_FACT_FILTER,
  type CheckFact,
  isGreen,
  selectRequiredCheck,
} from '../../src/repo/required-check.ts';
import { capture } from '../receivers/capture.ts';

const run = (over: CheckFact): CheckFact => ({
  name: 'Check',
  appId: REQUIRED_CHECK_APP_ID,
  status: 'COMPLETED',
  conclusion: 'SUCCESS',
  startedAt: '2026-11-17T10:00:00Z',
  ...over,
});

test('a same-named Check of a foreign App is never the required check', () => {
  assert.equal(selectRequiredCheck([run({ appId: 99 })]), undefined);
  const required = run({
    conclusion: 'FAILURE',
    startedAt: '2026-11-17T09:00:00Z',
  });
  const foreign = run({ appId: 99, startedAt: '2026-11-17T11:00:00Z' });
  assert.equal(selectRequiredCheck([required, foreign]), required);
  assert.equal(selectRequiredCheck([foreign, required]), required);
  assert.equal(selectRequiredCheck([run({ appId: undefined })]), undefined);
});

test('the aggregate of a reusable workflow is selected, a job named like it is not', () => {
  const nested = run({ name: 'ci / Check' });
  assert.equal(selectRequiredCheck([nested]), nested);
  assert.equal(selectRequiredCheck([run({ name: 'Lint' })]), undefined);
  assert.equal(selectRequiredCheck([run({ name: 'Recheck' })]), undefined);
});

test('only SUCCESS is green: skipped, neutral and missing conclusions are not', () => {
  assert.equal(isGreen('SUCCESS'), true);
  for (const c of [
    'SKIPPED',
    'NEUTRAL',
    'STALE',
    'FAILURE',
    '',
    undefined,
    null,
  ])
    assert.equal(isGreen(c), false, String(c));
});

test('the check-runs filter reads the App id from a verbatim check-runs answer', () => {
  const answer = readFileSync(
    new URL(
      '../fixtures/ci-admission/reusable-check-runs.json',
      import.meta.url,
    ),
    'utf8',
  );
  const out = spawnSync('jq', ['-c', CHECK_FACT_FILTER], {
    input: answer,
    encoding: 'utf8',
  });
  assert.equal(out.status, 0, out.stderr);
  const facts = JSON.parse(out.stdout) as CheckFact[];
  assert.ok(facts.length > 0);
  assert.ok(facts.every((f) => f.appId === 15368));
});

test('a failed Check attempt is superseded while a newer row of its Actions run is unfinished, not after', () => {
  const supersededByRerun = (requiredCheck as Partial<typeof requiredCheck>)
    .supersededByRerun;
  assert.ok(supersededByRerun, 'required-check exports supersededByRerun');
  // PR #1449's check-runs after `gh run rerun 44381299774 --failed` concluded (real output, CHECK_FACT_FILTER).
  const facts = JSON.parse(
    capture(
      'fixtures/gh',
      'check-runs-1449-rerun-attempts',
    ).streams.stdout?.toString('utf8') ?? '',
  ) as CheckFact[];
  assert.ok(facts.every((f) => typeof f.id === 'number'));
  const attempt2Check = 135080025160;
  const attempt2Rerun = 135079345220;
  // While attempt 2 ran: its aggregate row did not exist yet and its rerun job was in progress.
  const running = facts
    .filter((f) => f.id !== attempt2Check)
    .map((f) =>
      f.id === attempt2Rerun
        ? { ...f, status: 'IN_PROGRESS', conclusion: '' }
        : f,
    );
  const stale = selectRequiredCheck(running);
  assert.equal(stale?.conclusion, 'FAILURE');
  assert.equal(stale && supersededByRerun(stale, running), true);
  const final = selectRequiredCheck(facts);
  assert.equal(final?.id, attempt2Check);
  assert.equal(final && supersededByRerun(final, facts), false);
  // A finished run with nothing newer, a row of another run, or a row without id never supersedes.
  const failed = run({
    id: 5,
    conclusion: 'FAILURE',
    detailsUrl: 'https://github.com/o/r/actions/runs/9/job/5',
  });
  const other = run({
    id: 6,
    status: 'IN_PROGRESS',
    detailsUrl: 'https://github.com/o/r/actions/runs/10/job/6',
  });
  assert.equal(supersededByRerun(failed, [failed, other]), false);
  assert.equal(supersededByRerun({ ...failed, id: null }, [failed]), false);
});

const repo = JSON.stringify({
  default_branch: 'main',
  allow_auto_merge: true,
});
const protection = (context: string, appId: number) =>
  JSON.stringify({
    protection: {
      required_status_checks: { checks: [{ context, app_id: appId }] },
    },
  });
const gap =
  'branch main has no single required status check from GitHub Actions';

test('verify accepts only the aggregate Check of the required App as the required check', () => {
  assert.deepEqual(verifyGaps(repo, protection('Check', 15368)), []);
  assert.deepEqual(verifyGaps(repo, protection('Check', 99)), [gap]);
  assert.deepEqual(verifyGaps(repo, protection('Lint', 15368)), [gap]);
  const ruleset = (context: string) =>
    JSON.stringify([
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [{ context, integration_id: 15368 }],
        },
      },
    ]);
  assert.deepEqual(verifyGaps(repo, '{}', ruleset('Check')), []);
  assert.deepEqual(verifyGaps(repo, '{}', ruleset('Lint')), [gap]);
});
