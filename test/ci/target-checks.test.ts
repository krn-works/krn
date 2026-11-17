import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { verifyGaps } from '../../src/adopt/verify.ts';
import { REQUIRED_CHECK_APP_ID } from '../../src/repo/ci-admission-contract.ts';
import {
  CHECK_FACT_FILTER,
  type CheckFact,
  isGreen,
  selectRequiredCheck,
} from '../../src/repo/required-check.ts';

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
