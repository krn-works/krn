// Delivery friction: how many of the last merged PRs were reverts, beside first-push-green.
import { gh, ghRepoView } from '../repo/gh.ts';
import {
  array,
  callRun,
  number,
  object,
  parse,
  type Run,
  string,
} from './ledger.ts';

/** Merged PRs the measure covers unless `--limit` says otherwise. */
export const REVERT_RATE_PRS = 50;

export type MergedPr = { number: number; title: string; body: string };

export type RevertRate = {
  /** Merged PRs read. */
  merged: number;
  reverts: { number: number; title: string; reverted: number | null }[];
  /** reverts / merged, or null when no PR was read. */
  share: number | null;
};

const REVERT_TITLE = /^Revert "(.*)"\s*$/;

/**
 * Pairs every `Revert "<title>"` PR with the merged PR it undoes: the PR the
 * body names (`Reverts owner/repo#N`, `Reverts .../pull/N`), else the newest
 * earlier PR in the list whose title is the quoted one; null when none is.
 */
export function summarizeReverts(prs: MergedPr[]): RevertRate {
  const reverts = prs
    .map((pr) => ({ pr, quoted: REVERT_TITLE.exec(pr.title)?.[1] }))
    .filter(
      (r): r is { pr: MergedPr; quoted: string } => r.quoted !== undefined,
    )
    .map(({ pr, quoted }) => {
      const named = /Reverts?\s+(?:\S*#|\S*\/pull\/)(\d+)/i.exec(pr.body)?.[1];
      const byTitle = prs
        .filter((p) => p.number < pr.number && p.title === quoted)
        .map((p) => p.number)
        .sort((a, b) => b - a)[0];
      return {
        number: pr.number,
        title: pr.title,
        reverted: named ? Number(named) : (byTitle ?? null),
      };
    });
  return {
    merged: prs.length,
    reverts,
    share: prs.length ? reverts.length / prs.length : null,
  };
}

export type RevertRateOptions = { limit?: number; repo?: string; run?: Run };

/** Reads the last merged PRs from GitHub. */
export async function collectRevertRate(
  options: RevertRateOptions = {},
): Promise<RevertRate> {
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
        String(options.limit ?? REVERT_RATE_PRS),
        '--json',
        'number,title,body',
      ]),
    ),
  ).map(object);
  return summarizeReverts(
    listed.map((p) => ({
      number: number(p.number) ?? 0,
      title: string(p.title),
      body: string(p.body),
    })),
  );
}

export function renderRevertRate(r: RevertRate): string {
  const pct = r.share === null ? 'n/a' : `${(r.share * 100).toFixed(1)}%`;
  const lines = [
    `Revert rate: ${pct} (${r.reverts.length} reverts / ${r.merged} merged PRs)`,
    ...r.reverts.map(
      (v) =>
        `#${v.number} ${v.title} reverts ${v.reverted === null ? 'unknown' : `#${v.reverted}`}`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
