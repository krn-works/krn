// The receiver probe a lane runs before its paid session: GitHub must gate the base and the base must not be red.

import { z } from 'zod';
import { requiredContexts } from '../../adopt/verify.ts';
import { ghApiSync } from '../../repo/gh.ts';
import {
  type CheckFact,
  selectRequiredCheck,
} from '../../repo/required-check.ts';

/** The answers of the three `gh api` reads the probe makes, stdout verbatim. */
export interface ReceiverReplies {
  branch: string;
  rules: string;
  /** `gh api repos/<repo>/commits/<base head>/check-runs`. */
  checkRuns: string;
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

/** Conclusions that prove the base red; pending, cancelled, absent and neutral prove nothing. */
const red = new Set(['FAILURE', 'TIMED_OUT']);

/**
 * Why the receiver cannot take a delivery: the base has no single required Check from GitHub Actions,
 * or that Check finished red on the base head. A missing or pending Check run on the head is not a gap.
 */
export function receiverGaps(base: string, replies: ReceiverReplies): string[] {
  if (requiredContexts(replies.branch, replies.rules).length !== 1)
    return [
      `branch ${base} has no single required status check from GitHub Actions, so no delivery can merge`,
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

/** The probe against GitHub from the checkout `root`, with the identity gh has there; an unreachable receiver is a gap. */
export function probeReceiver(root: string, base: string): string[] {
  try {
    const branch = read(root, `repos/{owner}/{repo}/branches/${base}`);
    const head = branchHeadSchema.parse(JSON.parse(branch)).commit.sha;
    return receiverGaps(base, {
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
