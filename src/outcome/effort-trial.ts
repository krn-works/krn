// The effort policy report: lane PRs grouped by arm (before the policy, under it), with first-push-green and cost per PR.
import { gh, ghRepoView } from '../repo/gh.ts';
import {
  collectFirstPushGreen,
  type FirstPushGreen,
  summarize,
} from './first-push-green.ts';
import { type EffortArm, effortArm } from './lane-effort.ts';
import {
  array,
  callRun,
  collectLedger,
  number,
  object,
  parse,
  type Run,
  string,
} from './ledger.ts';

export type EffortArmReport = {
  arm: EffortArm;
  prs: number;
  result: FirstPushGreen;
  /** Mean dollars per PR over the PRs whose cost the ledger priced, or null when none was priced. */
  costPerPr: number | null;
  /** PRs of the arm with a priced cost. */
  priced: number;
};

/** Splits merged PRs (`number`, `body`) into the two arms; PRs that are not lane PRs are dropped. */
export function effortArmsOf(prs: unknown[]): Record<EffortArm, number[]> {
  const arms: Record<EffortArm, number[]> = {
    'before-policy': [],
    'under-policy': [],
  };
  for (const pr of prs.map(object)) {
    const arm = effortArm(string(pr.body));
    const n = number(pr.number);
    if (arm !== undefined && n !== null) arms[arm].push(n);
  }
  return arms;
}

/** Dollars per merged PR as the ledger prices them. */
async function ledgerCosts(
  repo: string,
  limit: number,
  run: Run,
): Promise<Map<number, number>> {
  const { rows } = await collectLedger({ repo, limit, run });
  const costs = new Map<number, number>();
  for (const row of rows) {
    const dollars = row.cost?.dollars;
    if (typeof dollars === 'number') costs.set(row.number, dollars);
  }
  return costs;
}

export async function collectEffortTrial(
  options: {
    limit?: number;
    repo?: string;
    run?: Run;
    /** Dollars by PR number; the default prices them from the ledger. */
    costs?: Map<number, number>;
  } = {},
): Promise<EffortArmReport[]> {
  const run = options.run ?? callRun(90_000);
  const repo =
    options.repo ?? string(object(parse(await ghRepoView(run))).nameWithOwner);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid repository');
  const limit = options.limit ?? 200;
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
        String(limit),
        '--json',
        'number,body',
      ]),
    ),
  );
  const arms = effortArmsOf(listed);
  const known = Object.values(arms).flat();
  const costs =
    options.costs ??
    (known.length ? await ledgerCosts(repo, limit, run) : new Map());
  const reports: EffortArmReport[] = [];
  for (const arm of ['before-policy', 'under-policy'] as const) {
    const numbers = arms[arm];
    const result = numbers.length
      ? await collectFirstPushGreen({ numbers, repo, run })
      : summarize([]);
    const priced = numbers
      .map((n) => costs.get(n))
      .filter((d): d is number => d !== undefined);
    reports.push({
      arm,
      prs: numbers.length,
      result,
      priced: priced.length,
      costPerPr: priced.length
        ? priced.reduce((a, b) => a + b, 0) / priced.length
        : null,
    });
  }
  return reports;
}

export function renderEffortTrial(reports: EffortArmReport[]): string {
  const lines = reports.map((r) => {
    const pct =
      r.result.share === null ? 'n/a' : `${(r.result.share * 100).toFixed(1)}%`;
    const cost =
      r.costPerPr === null
        ? 'n/a'
        : `$${r.costPerPr.toFixed(2)} (${r.priced} priced)`;
    return `${r.arm}: ${r.prs} PRs, first-push-green ${pct} (${r.result.green} of ${r.result.measured}), cost per PR ${cost}`;
  });
  return `${lines.join('\n')}\n`;
}
