import { z } from 'zod';
import {
  type GateAdmissionPolicy,
  KRN_CHECK_APP_ID,
  matchesGateCheckRun,
} from './admission-policy.ts';
import { gateFailureLine } from './gate-failure.ts';

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
}
export class GateTimeout extends Error {}
export async function waitForGate({
  repo,
  pr,
  head,
  onMain = false,
  policy,
  gh,
  sleep,
  now,
  pollMs,
  timeoutMs,
}: GateWaitOptions): Promise<string> {
  const poll = async (condition: () => Promise<boolean>) => {
    const deadline = now() + timeoutMs;
    while (!(await condition())) {
      if (now() >= deadline) throw new GateTimeout('bounded wait timed out');
      await sleep(pollMs);
    }
  };
  let conclusion = 'pending';
  await poll(async () => {
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
    const checks = pages.flatMap((page) => page.check_runs);
    if (
      policy.source === 'legacy-actions' &&
      checks.some((check) =>
        matchesGateCheckRun(check, head, {
          source: 'pinned-app',
          checkRunName: 'krn/gate',
          appId: KRN_CHECK_APP_ID,
        }),
      )
    )
      throw new Error(
        'base selects legacy GitHub Actions but native CI is present; update branch from main or reconcile base CI policy',
      );
    const gate = checks
      .filter((check) => matchesGateCheckRun(check, head, policy))
      .sort((a, b) => b.id - a.id)[0];
    if (gate?.status !== 'completed') return false;
    conclusion = gate.conclusion ?? 'unknown';
    if (conclusion !== 'success')
      throw new Error(
        `gate concluded ${conclusion} on ${head}; ${gateFailureLine(gate.output)}; rerun: ${
          onMain
            ? 'main has no lead rerun (the lead Jenkins account builds PR jobs only); the next merge to main runs the gate again'
            : `krn ci rerun --pr ${pr} --head ${head}`
        }`,
      );
    return true;
  });
  return conclusion;
}
