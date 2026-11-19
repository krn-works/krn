import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  actionsRefusedGap,
  failedLatestRun,
  receiverGaps,
  refusedJob,
} from '../../src/cli/lane-run/receiver.ts';

// Verbatim gh api replies of krn-works/krn, listed in test/fixtures/gh/provenance.json.
const gh = (name: string) =>
  readFileSync(
    new URL(`../fixtures/gh/${name}.stdout.json`, import.meta.url),
    'utf8',
  );

const gated = {
  repo: gh('repo-krn-works-krn'),
  branch: gh('branch-main-krn-works-krn'),
  rules: gh('rules-branches-main-krn-works-krn'),
};

test('a gated base whose head Check succeeded is ready', () => {
  assert.deepEqual(
    receiverGaps('main', { ...gated, checkRuns: gh('check-runs-main-green') }),
    [],
  );
});

test('a base whose head Check failed is a red baseline', () => {
  const gaps = receiverGaps('main', {
    ...gated,
    checkRuns: gh('check-runs-main-red'),
  });
  assert.equal(gaps.length, 1);
  assert.match(
    gaps[0] ?? '',
    /required check Check is failure .*baseline is red/u,
  );
});

test('a branch without a required Check from GitHub Actions is not ready', () => {
  const gaps = receiverGaps('doctor-skill-perms', {
    repo: gh('repo-krn-works-krn'),
    branch: gh('branch-unprotected-krn-works-krn'),
    rules: gh('rules-branches-unprotected-krn-works-krn'),
    checkRuns: gh('check-runs-main-green'),
  });
  assert.equal(gaps.length, 1);
  assert.match(gaps[0] ?? '', /no single required status check/u);
});

test('a head with no Check run yet proves nothing and is ready', () => {
  assert.deepEqual(
    receiverGaps('main', {
      ...gated,
      checkRuns: '{"total_count":0,"check_runs":[]}',
    }),
    [],
  );
});

// Verbatim replies of krn-works/seo-audit-harness while GitHub refused its jobs for billing (run 44376005035).
test('a newest run whose jobs GitHub never started names the billing refusal', () => {
  const runId = failedLatestRun(gh('runs-latest-billing-refused'));
  assert.equal(runId, 44376005035);
  const jobId = refusedJob(gh('run-44376005035-jobs-billing-refused'));
  assert.equal(jobId, 135055234000);
  assert.match(
    actionsRefusedGap(
      44376005035,
      gh('annotations-135055234000-billing-refused'),
    ),
    /did not start the jobs of run 44376005035.*spending limit/u,
  );
});

test('a green newest run needs no jobs read', () => {
  assert.equal(failedLatestRun(gh('runs-latest-main-green')), undefined);
});

test('a job that ran its steps and failed is a red test, not a refusal', () => {
  const ran = JSON.stringify({
    jobs: [
      {
        id: 1,
        conclusion: 'failure',
        runner_name: 'GitHub Actions 1',
        steps: [{ name: 'Test' }],
      },
    ],
  });
  assert.equal(refusedJob(ran), undefined);
});

test('a repository with auto-merge disabled is not ready', () => {
  const repo = JSON.stringify({
    ...JSON.parse(gh('repo-krn-works-krn')),
    allow_auto_merge: false,
  });
  const gaps = receiverGaps('main', {
    ...gated,
    repo,
    checkRuns: gh('check-runs-main-green'),
  });
  assert.equal(gaps.length, 1);
  assert.match(gaps[0] ?? '', /auto-merge is not allowed/u);
});

test('a token without the workflows permission cannot deliver a workflow edit', () => {
  const replies = { ...gated, checkRuns: gh('check-runs-main-green') };
  const gaps = receiverGaps('main', {
    ...replies,
    editsWorkflows: true,
    permissions: { contents: 'write', pull_requests: 'write' },
  });
  assert.match(gaps[0] ?? '', /lacks the workflows permission/u);
  assert.deepEqual(
    receiverGaps('main', {
      ...replies,
      editsWorkflows: true,
      permissions: { workflows: 'write' },
    }),
    [],
  );
  // A lane that edits no workflow, or a token whose permissions are unknown, is not refused.
  assert.deepEqual(
    receiverGaps('main', { ...replies, permissions: { contents: 'write' } }),
    [],
  );
  assert.deepEqual(
    receiverGaps('main', { ...replies, editsWorkflows: true }),
    [],
  );
});
