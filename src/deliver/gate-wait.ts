import { z } from 'zod';
import {
  type GateAdmissionPolicy,
  matchesGateCheckRun,
} from './admission-policy.ts';

const sha = z.string().regex(/^[a-f\d]{40}$/u);
const checksSchema = z.array(
  z.object({
    check_runs: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        head_sha: sha,
        status: z.string(),
        conclusion: z.string().nullable(),
        details_url: z.string().nullable().optional(),
        output: z.unknown().optional(),
        app: z
          .object({
            id: z.number().int().positive().optional(),
            slug: z.string().optional(),
          })
          .nullable(),
      }),
    ),
  }),
);

export const pullSchema = z.object({
  head: z.object({ sha }),
  mergeable_state: z.string(),
  state: z.string().optional(),
  merged: z.boolean().optional(),
  merge_commit_sha: sha.nullable().optional(),
  auto_merge: z.unknown().optional(),
});
export type Pull = z.infer<typeof pullSchema>;

interface GateWaitOptions {
  repo: string;
  pr: number;
  head: string;
  onMain?: boolean;
  policy: GateAdmissionPolicy;
  gh: (args: string[]) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollMs: number;
  timeoutMs: number;
  startTimeoutMs?: number;
  /** Receives every pull read, so a caller can see auto-merge without another request. */
  onPull?: (pull: Pull) => void;
}
/** Why a wait stopped before its gate concluded; each reason owns an exit code. */
type GateStopReason = 'conflict' | 'head-moved' | 'never-started';
export class GateStopped extends Error {
  readonly reason: GateStopReason;
  constructor(reason: GateStopReason, message: string) {
    super(message);
    this.reason = reason;
  }
}
export class GateTimeout extends Error {
  readonly state: string;
  readonly seconds: number;
  constructor(
    timeoutMs: number,
    state: string,
    head: string,
    checkRunName = 'Check',
  ) {
    const seconds = Math.floor(timeoutMs / 1000);
    const safeState = (state.split(/[\n\r\u2028\u2029]/u)[0] ?? '')
      .replace(/[\p{Cc}\p{Cf}]/gu, '')
      .slice(0, 32);
    super(
      `bounded wait timed out after ${seconds}s: ${checkRunName} ${safeState} on ${head}; rerun the same command to resume`,
    );
    this.state = safeState;
    this.seconds = seconds;
  }
}
/**
 * A run cancelled by the workflow's concurrency group is superseded by a newer
 * run on the same head (e.g. after a PR body edit); that run's Check appears
 * moments later, so a cancelled newest check is awaited this long first.
 */
const runSchema = z.object({
  status: z.string().nullable(),
  conclusion: z.string().nullable().optional(),
});
/**
 * How the Actions run behind a failed Check is moving: running
 * again after a rerun, or cancelled by a newer run on the same head (its jobs
 * are cancelled, so the aggregate Check fails while the newer run starts).
 */
async function runSuperseded(
  gh: (args: string[]) => Promise<string>,
  repo: string,
  runId: string,
): Promise<'running' | 'cancelled' | 'done'> {
  const run = runSchema.parse(
    JSON.parse(await gh(['api', `repos/${repo}/actions/runs/${runId}`])),
  );
  if (run.status !== null && run.status !== 'completed') return 'running';
  return run.conclusion === 'cancelled' ? 'cancelled' : 'done';
}
const supersededGraceMs = 120_000;

export async function waitForGate({
  repo,
  pr,
  head,
  policy,
  gh,
  sleep,
  now,
  pollMs,
  timeoutMs,
  startTimeoutMs = timeoutMs,
  onPull,
}: GateWaitOptions): Promise<string> {
  const started = now();
  const deadline = started + timeoutMs;
  let cancelledSince: number | undefined;
  for (;;) {
    // GitHub starts no pull_request workflow for a conflicting PR and none
    // for an old head, so both stop the wait instead of polling to the bound.
    const pull = pullSchema.parse(
      JSON.parse(await gh(['api', `repos/${repo}/pulls/${pr}`])),
    );
    onPull?.(pull);
    if (pull.head.sha !== head)
      throw new GateStopped(
        'head-moved',
        `head moved: PR #${pr} is at ${pull.head.sha}, not ${head}; wait on the new head`,
      );
    if (pull.mergeable_state === 'dirty')
      throw new GateStopped(
        'conflict',
        `PR #${pr} conflicts with its base; rebase it, push, and wait on the new head`,
      );
    const pages = checksSchema.parse(
      JSON.parse(
        await gh([
          'api',
          '--paginate',
          '--slurp',
          `repos/${repo}/commits/${head}/check-runs?filter=all&per_page=100`,
        ]),
      ),
    );
    const gate = pages
      .flatMap((page) => page.check_runs)
      .filter((check) => matchesGateCheckRun(check, head, policy))
      .sort((a, b) => b.id - a.id)[0];
    if (gate?.status === 'completed') {
      const conclusion = gate.conclusion ?? 'unknown';
      if (conclusion === 'cancelled') {
        cancelledSince ??= now();
        if (now() - cancelledSince < supersededGraceMs && now() < deadline) {
          await sleep(pollMs);
          continue;
        }
      } else cancelledSince = undefined;
      if (conclusion !== 'success') {
        const runId = /\/actions\/runs\/(\d+)\//u.exec(
          gate.details_url ?? '',
        )?.[1];
        // `gh run rerun --failed` starts a newer attempt of the same run; until
        // its Check run appears the failed one is the newest, so a run that is
        // running again is awaited instead of reported failed. A cancelled run
        // is awaited for the same grace as a cancelled Check.
        const moving =
          runId === undefined || now() >= deadline
            ? 'done'
            : await runSuperseded(gh, repo, runId);
        if (moving === 'cancelled') cancelledSince ??= now();
        if (
          moving === 'running' ||
          (moving === 'cancelled' &&
            cancelledSince !== undefined &&
            now() - cancelledSince < supersededGraceMs)
        ) {
          await sleep(pollMs);
          continue;
        }
        throw new Error(
          runId === undefined
            ? `${policy.checkRunName} concluded ${conclusion} on ${head}; rerun: gh run rerun <run-id> --failed (gh run list --commit ${head})`
            : `${policy.checkRunName} concluded ${conclusion} on ${head} in run ${runId}; logs: bin/krn ci logs --run ${runId}; rerun: gh run rerun ${runId} --failed`,
        );
      }
      return conclusion;
    }
    const state = gate?.status ?? 'missing';
    if (gate === undefined && now() - started >= startTimeoutMs)
      throw new GateStopped(
        'never-started',
        `${policy.checkRunName} never started on ${head} within ${Math.floor(startTimeoutMs / 1000)}s; check the PR's workflows`,
      );
    if (now() >= deadline)
      throw new GateTimeout(timeoutMs, state, head, policy.checkRunName);
    await sleep(pollMs);
  }
}
