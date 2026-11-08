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

const pullSchema = z.object({
  head: z.object({ sha }),
  mergeable_state: z.string(),
});

export interface GateWaitOptions {
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
}
/** Why a wait stopped before its gate concluded; each reason owns an exit code. */
export type GateStopReason = 'conflict' | 'head-moved' | 'never-started';
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
}: GateWaitOptions): Promise<string> {
  const started = now();
  const deadline = started + timeoutMs;
  for (;;) {
    // GitHub starts no pull_request workflow for a conflicting PR and none
    // for an old head, so both stop the wait instead of polling to the bound.
    const pull = pullSchema.parse(
      JSON.parse(await gh(['api', `repos/${repo}/pulls/${pr}`])),
    );
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
      if (conclusion !== 'success') {
        const runId = /\/actions\/runs\/(\d+)\//u.exec(
          gate.details_url ?? '',
        )?.[1];
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
