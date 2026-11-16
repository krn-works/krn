// Delivery friction: the share of merged PRs whose first pushed head got a green Check, and the CI rounds per PR.
import { REQUIRED_CHECK_APP_ID } from '../repo/ci-admission-contract.ts';
import { gh, ghRepoView } from '../repo/gh.ts';
import {
  array,
  callRun,
  mapLimited,
  number,
  object,
  parse,
  type Run,
  string,
  time,
} from './ledger.ts';

/** Merged PRs the measure covers unless `--limit` says otherwise. */
export const FIRST_PUSH_GREEN_PRS = 50;
const CHECK_CONCURRENCY = 12;

/**
 * The aggregate Check runs of one commit, as `gh api` prints them: the jq
 * filter keeps only the Actions app's `Check` (or `<caller> / Check`) runs.
 */
export const CHECK_RUN_FILTER = `[.check_runs[] | select(.app.id == ${REQUIRED_CHECK_APP_ID} and (.name | test("(^|/ )Check$"))) | {name, head_sha, status, conclusion, started_at, completed_at}]`;

export type PrRounds = {
  number: number;
  /** Distinct pushed head SHAs that got a completed Check. */
  rounds: number;
  /** Conclusion of the first such head's first Check, or null when no head got one. */
  first: string | null;
};

export type FirstPushGreen = {
  prs: PrRounds[];
  /** PRs with at least one completed Check. */
  measured: number;
  green: number;
  /** green / measured, or null when nothing was measured. */
  share: number | null;
  /** Mean rounds over measured PRs, or null when nothing was measured. */
  meanRounds: number | null;
};

/** A cancelled or skipped run never judged the head, so it is not a round. */
const judged = (run: Record<string, unknown>) =>
  string(run.status) === 'completed' &&
  !['cancelled', 'skipped', 'stale'].includes(string(run.conclusion));

/** Rounds of one PR from the Check runs of each of its commits (oid to runs). */
export function prRounds(pr: number, checks: Map<string, unknown[]>): PrRounds {
  const heads = [...checks.values()]
    .map((runs) => {
      const done = runs
        .map(object)
        .filter(judged)
        .sort((a, b) => (time(a.started_at) ?? 0) - (time(b.started_at) ?? 0));
      return { first: done[0], at: time(done[0]?.started_at) ?? 0 };
    })
    .filter((h) => h.first !== undefined)
    .sort((a, b) => a.at - b.at);
  return {
    number: pr,
    rounds: heads.length,
    first: heads[0] ? string(heads[0].first?.conclusion) : null,
  };
}

export function summarize(prs: PrRounds[]): FirstPushGreen {
  const measured = prs.filter((p) => p.rounds > 0);
  const green = measured.filter((p) => p.first === 'success').length;
  const rounds = measured.reduce((n, p) => n + p.rounds, 0);
  return {
    prs,
    measured: measured.length,
    green,
    share: measured.length ? green / measured.length : null,
    meanRounds: measured.length ? rounds / measured.length : null,
  };
}

export type FirstPushGreenOptions = {
  limit?: number;
  repo?: string;
  run?: Run;
};

/** Reads the last merged PRs and the Check runs of every commit on them from GitHub. */
export async function collectFirstPushGreen(
  options: FirstPushGreenOptions = {},
): Promise<FirstPushGreen> {
  const run = options.run ?? callRun(90_000);
  const repo =
    options.repo ?? string(object(parse(await ghRepoView(run))).nameWithOwner);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid repository');
  const merged = array(
    parse(
      await gh(run, [
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'merged',
        '--limit',
        String(options.limit ?? FIRST_PUSH_GREEN_PRS),
        '--json',
        'number',
      ]),
    ),
  ).map(object);
  const prs = await mapLimited(merged, CHECK_CONCURRENCY, async (pr) => {
    // One list query with commits exceeds the GraphQL node limit at 50 PRs, so commits are read per PR.
    const view = parse(
      await gh(run, [
        'pr',
        'view',
        String(pr.number),
        '--repo',
        repo,
        '--json',
        'commits',
        '--jq',
        '[.commits[].oid]',
      ]),
    );
    const shas = array(view).map(string).filter(Boolean);
    const checks = new Map<string, unknown[]>();
    for (const sha of shas) {
      const reply = await gh(run, [
        'api',
        `repos/${repo}/commits/${sha}/check-runs?filter=all&per_page=100`,
        '--jq',
        CHECK_RUN_FILTER,
      ]);
      checks.set(sha, array(parse(reply)));
    }
    return prRounds(number(pr.number) ?? 0, checks);
  });
  return summarize(prs);
}

export function renderFirstPushGreen(r: FirstPushGreen): string {
  const pct = r.share === null ? 'n/a' : `${(r.share * 100).toFixed(1)}%`;
  const mean = r.meanRounds === null ? 'n/a' : r.meanRounds.toFixed(2);
  const lines = [
    `First-push-green: ${pct} (${r.green} of ${r.measured} merged PRs with a completed Check)`,
    `CI rounds per PR (distinct pushed heads with a completed Check): mean ${mean}`,
    `PRs without a completed Check: ${r.prs.length - r.measured}`,
    ...r.prs.map(
      (p) => `#${p.number} rounds ${p.rounds} first ${p.first ?? 'none'}`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
