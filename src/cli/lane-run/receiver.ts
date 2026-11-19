// The receiver probe a lane runs before its paid session: GitHub must gate the base, the base must not be red and Actions must start jobs.

import { z } from 'zod';
import { verifyGaps } from '../../adopt/verify.ts';
import { cachedPermissions } from '../../ci/app-token.ts';
import { ghApiSync } from '../../repo/gh.ts';
import {
  type CheckFact,
  selectRequiredCheck,
} from '../../repo/required-check.ts';

/** The answers of the three `gh api` reads the probe makes, stdout verbatim. */
export interface ReceiverReplies {
  /** `gh api repos/<repo>`: the repository settings (auto-merge). */
  repo: string;
  branch: string;
  rules: string;
  /** `gh api repos/<repo>/commits/<base head>/check-runs`. */
  checkRuns: string;
  /** The permissions GitHub granted the delivery token; undefined when unknown (an older cache, no cache). */
  permissions?: Record<string, string> | undefined;
  /** Whether the lane edits `.github/workflows`, the one change that needs the `workflows` permission. */
  editsWorkflows?: boolean;
}

const checkRunsSchema = z.object({
  check_runs: z.array(
    z.object({
      name: z.string(),
      status: z.string().nullable(),
      conclusion: z.string().nullable(),
      started_at: z.string().nullable(),
      app: z.object({ id: z.number() }).nullable(),
    }),
  ),
});

const branchHeadSchema = z.object({ commit: z.object({ sha: z.string() }) });

const latestRunSchema = z.object({
  workflow_runs: z.array(
    z.object({ id: z.number(), conclusion: z.string().nullable() }),
  ),
});

const jobsSchema = z.object({
  jobs: z.array(
    z.object({
      id: z.number(),
      conclusion: z.string().nullable(),
      runner_name: z.string().nullable(),
      steps: z.array(z.unknown()).optional(),
    }),
  ),
});

const annotationsSchema = z.array(z.object({ message: z.string() }));

/** The id of the newest workflow run when it failed, the one run whose jobs can show that Actions refuses to start jobs. */
export function failedLatestRun(runs: string): number | undefined {
  const latest = latestRunSchema.parse(JSON.parse(runs)).workflow_runs[0];
  return latest?.conclusion === 'failure' ? latest.id : undefined;
}

/** A job GitHub failed without ever giving it a runner or a step: Actions refused to start it (billing, spending limit). */
export function refusedJob(jobs: string): number | undefined {
  return jobsSchema
    .parse(JSON.parse(jobs))
    .jobs.find(
      (job) =>
        job.conclusion === 'failure' &&
        !job.runner_name &&
        (job.steps ?? []).length === 0,
    )?.id;
}

/** The gap a refused job proves: no Check can run, so no delivery can merge; GitHub's own annotation says why. */
export function actionsRefusedGap(runId: number, annotations: string): string {
  const why =
    annotationsSchema.parse(JSON.parse(annotations))[0]?.message ??
    'no annotation';
  return `GitHub Actions did not start the jobs of run ${runId}, so no Check can pass: ${why}`;
}

/** Conclusions that prove the base red; pending, cancelled, absent and neutral prove nothing. */
const red = new Set(['FAILURE', 'TIMED_OUT']);

/**
 * Why the receiver cannot take a delivery: the base has no single required Check from GitHub Actions,
 * or that Check finished red on the base head. A missing or pending Check run on the head is not a gap.
 */
export function receiverGaps(base: string, replies: ReceiverReplies): string[] {
  // The adopt check: auto-merge allowed and one required check from GitHub Actions.
  const settings = verifyGaps(replies.repo, replies.branch, replies.rules);
  if (settings.length > 0)
    return settings.map((gap) => `${gap}, so no delivery can merge on ${base}`);
  if (
    replies.editsWorkflows === true &&
    replies.permissions !== undefined &&
    replies.permissions.workflows !== 'write'
  )
    return [
      'the delivery GitHub App token lacks the workflows permission (write), so a push that edits .github/workflows is refused; grant the App Workflows (write)',
    ];
  const runs: CheckFact[] = checkRunsSchema
    .parse(JSON.parse(replies.checkRuns))
    .check_runs.map((run) => ({
      name: run.name,
      appId: run.app?.id,
      startedAt: run.started_at,
      status: run.status?.toUpperCase() ?? null,
      conclusion: run.conclusion?.toUpperCase() ?? null,
    }));
  const check = selectRequiredCheck(runs);
  if (
    check?.status === 'COMPLETED' &&
    red.has(check.conclusion ?? '') &&
    check.name !== undefined
  )
    return [
      `the required check ${check.name} is ${check.conclusion?.toLowerCase()} on the head of ${base}: the baseline is red`,
    ];
  return [];
}

function read(root: string, path: string): string {
  const reply = ghApiSync(root, path);
  if (reply.status !== 0)
    throw new Error(
      `gh api ${path} failed (exit ${reply.status ?? 'none'}): ${reply.stderr.trim().split('\n')[0] || reply.error?.message || ''}`,
    );
  return reply.stdout;
}

export interface ReceiverProbeOptions {
  /** The lane session environment: names the App token cache the permissions are read from. */
  env?: NodeJS.ProcessEnv;
  editsWorkflows?: boolean;
}

/** The probe against GitHub from the checkout `root`, with the identity gh has there; an unreachable receiver is a gap. */
export function probeReceiver(
  root: string,
  base: string,
  options: ReceiverProbeOptions = {},
): string[] {
  try {
    const branch = read(root, `repos/{owner}/{repo}/branches/${base}`);
    const head = branchHeadSchema.parse(JSON.parse(branch)).commit.sha;
    const runId = failedLatestRun(
      read(root, 'repos/{owner}/{repo}/actions/runs?per_page=1'),
    );
    if (runId !== undefined) {
      const jobId = refusedJob(
        read(root, `repos/{owner}/{repo}/actions/runs/${runId}/jobs`),
      );
      if (jobId !== undefined)
        return [
          actionsRefusedGap(
            runId,
            read(root, `repos/{owner}/{repo}/check-runs/${jobId}/annotations`),
          ),
        ];
    }
    return receiverGaps(base, {
      repo: read(root, 'repos/{owner}/{repo}'),
      permissions: cachedPermissions(options.env ?? process.env),
      editsWorkflows: options.editsWorkflows === true,
      branch,
      rules: read(root, `repos/{owner}/{repo}/rules/branches/${base}`),
      checkRuns: read(
        root,
        `repos/{owner}/{repo}/commits/${head}/check-runs?per_page=100`,
      ),
    });
  } catch (error) {
    return [
      `the receiver is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}
