// Spend per delivered PR: the ledger's slice cost joined with first-push-green, as dollars per merged PR and per first-push-green PR.
import { ghRepoView } from '../repo/gh.ts';
import {
  collectFirstPushGreen,
  type FirstPushGreen,
} from './first-push-green.ts';
import {
  callRun,
  collectLedger,
  type LedgerOptions,
  object,
  parse,
  string,
} from './ledger.ts';

export type DollarsPerPr = {
  /** Merged PRs whose slice cost is known; the figures below cover exactly these. */
  merged: number;
  /** Merged PRs left out because no priced transcript turn or a malformed transcript left their cost unknown. */
  unpriced: number;
  /** Priced PRs whose first pushed head got a green Check. */
  firstPushGreen: number;
  /** Dollars spent on the priced PRs, green or not. */
  totalDollars: number;
  /** totalDollars / merged, or null when no PR is priced. */
  perMerged: number | null;
  /** totalDollars / firstPushGreen: the red PRs' spend is carried by the green ones. Null when none is green. */
  perFirstPushGreen: number | null;
};

/** Joins per-PR dollars with the first-push-green result of the same PRs. */
export function joinDollars(
  costs: { number: number; dollars: number | null }[],
  firstPush: FirstPushGreen,
): DollarsPerPr {
  const green = new Set(
    firstPush.prs.filter((p) => p.first === 'success').map((p) => p.number),
  );
  const priced = costs.filter(
    (c): c is { number: number; dollars: number } => c.dollars !== null,
  );
  const total = priced.reduce((n, c) => n + c.dollars, 0);
  const greens = priced.filter((c) => green.has(c.number)).length;
  return {
    merged: priced.length,
    unpriced: costs.length - priced.length,
    firstPushGreen: greens,
    totalDollars: total,
    perMerged: priced.length ? total / priced.length : null,
    perFirstPushGreen: greens ? total / greens : null,
  };
}

export async function collectDollars(
  options: LedgerOptions = {},
): Promise<DollarsPerPr> {
  const run = options.run ?? callRun(90_000);
  const repo =
    options.repo ?? string(object(parse(await ghRepoView(run))).nameWithOwner);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid repository');
  const ledger = await collectLedger({ ...options, repo });
  const firstPush = await collectFirstPushGreen({
    numbers: ledger.rows.map((r) => r.number),
    repo,
    run,
  });
  return joinDollars(
    ledger.rows.map((r) => ({
      number: r.number,
      dollars: r.cost?.dollars ?? null,
    })),
    firstPush,
  );
}

export function renderDollars(d: DollarsPerPr): string {
  const money = (v: number | null) => (v === null ? 'n/a' : `$${v.toFixed(2)}`);
  return `${[
    `Dollars per merged PR: ${money(d.perMerged)} (${money(d.totalDollars)} over ${d.merged} priced merged PRs)`,
    `Dollars per first-push-green PR: ${money(d.perFirstPushGreen)} (${money(d.totalDollars)} over ${d.firstPushGreen} first-push-green PRs)`,
    `Merged PRs without a known cost: ${d.unpriced}`,
  ].join('\n')}\n`;
}
