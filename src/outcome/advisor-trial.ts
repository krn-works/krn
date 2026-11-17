// The advisor trial report: lane PRs grouped by arm, with first-push-green and CI rounds per PR.
import { gh, ghRepoView } from '../repo/gh.ts';
import {
  collectFirstPushGreen,
  type FirstPushGreen,
  summarize,
} from './first-push-green.ts';
import { type AdvisorArm, advisorArm } from './lane-advisor.ts';
import {
  array,
  callRun,
  number,
  object,
  parse,
  type Run,
  string,
} from './ledger.ts';

export type ArmReport = {
  arm: AdvisorArm;
  /** Merged lane PRs recorded in this arm. */
  prs: number;
  result: FirstPushGreen;
  /** Fable cost per PR in dollars when the PR bodies carry it; the ledger does not record advisor cost yet. */
  fableCostPerPr: number | null;
};

/** Splits merged PRs (`number`, `body`) into the two arms; PRs that are not lane PRs are dropped. */
export function armsOf(prs: unknown[]): Record<AdvisorArm, number[]> {
  const arms: Record<AdvisorArm, number[]> = { advisor: [], none: [] };
  for (const pr of prs.map(object)) {
    const arm = advisorArm(string(pr.body));
    const n = number(pr.number);
    if (arm !== undefined && n !== null) arms[arm].push(n);
  }
  return arms;
}

export async function collectAdvisorTrial(
  options: { limit?: number; repo?: string; run?: Run } = {},
): Promise<ArmReport[]> {
  const run = options.run ?? callRun(90_000);
  const repo =
    options.repo ?? string(object(parse(await ghRepoView(run))).nameWithOwner);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid repository');
  const listed = array(
    parse(
      await gh(run, [
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'merged',
        '--limit',
        String(options.limit ?? 200),
        '--json',
        'number,body',
      ]),
    ),
  );
  const arms = armsOf(listed);
  const reports: ArmReport[] = [];
  for (const arm of ['advisor', 'none'] as const) {
    const result = arms[arm].length
      ? await collectFirstPushGreen({ numbers: arms[arm], repo, run })
      : summarize([]);
    reports.push({ arm, prs: arms[arm].length, result, fableCostPerPr: null });
  }
  return reports;
}

export function renderAdvisorTrial(reports: ArmReport[]): string {
  const lines = reports.map((r) => {
    const pct =
      r.result.share === null ? 'n/a' : `${(r.result.share * 100).toFixed(1)}%`;
    const mean =
      r.result.meanRounds === null ? 'n/a' : r.result.meanRounds.toFixed(2);
    const cost =
      r.fableCostPerPr === null ? 'n/a' : `$${r.fableCostPerPr.toFixed(2)}`;
    return `${r.arm}: ${r.prs} PRs, first-push-green ${pct} (${r.result.green} of ${r.result.measured}), CI rounds per PR ${mean}, Fable cost per PR ${cost}`;
  });
  return `${lines.join('\n')}\n`;
}
