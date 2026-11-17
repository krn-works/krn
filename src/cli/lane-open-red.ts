import { newestCheck } from '../ci/ship.ts';
import { CliUsageError } from '../cli-kit/usage-error.ts';
import { ghPrListOpenSync } from '../repo/gh.ts';

type Run = { name?: string; startedAt?: string; conclusion?: string | null };
export type OpenPr = {
  number: number;
  statusCheckRollup?: Run[] | null;
};

const redConclusions = new Set([
  'FAILURE',
  'CANCELLED',
  'TIMED_OUT',
  'STARTUP_FAILURE',
  'ACTION_REQUIRED',
  'STALE',
]);

/** An open PR is red or missing when it has no aggregate Check run, or the newest one concluded red. */
export function redOrMissing(pr: OpenPr): boolean {
  const check = newestCheck(
    (pr.statusCheckRollup ?? []) as Parameters<typeof newestCheck>[0],
  );
  if (check === undefined) return true;
  return redConclusions.has(check.conclusion ?? '');
}

/** Reads the open PRs of the repository; undefined when gh is unavailable, unauthenticated or slow. */
export function readOpenPrs(main: string): OpenPr[] | undefined {
  const result = ghPrListOpenSync(main);
  if (result.error || result.status !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? (parsed as OpenPr[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Refuses a new lane while KRN_OPEN_RED_MAX (default 3) open PRs have a red or missing Check.
 * When the PR list cannot be read (gh missing, offline, unauthenticated) the check passes: an
 * unreadable list must not stop delivery, and the lane budget still applies.
 */
export function checkOpenRedLimit(
  main: string,
  read: (main: string) => OpenPr[] | undefined = readOpenPrs,
): void {
  const raw = process.env.KRN_OPEN_RED_MAX;
  const parsed = Number(raw);
  const max =
    raw !== undefined && raw !== '' && Number.isFinite(parsed) && parsed >= 0
      ? parsed
      : 3;
  const prs = read(main);
  if (prs === undefined) return;
  const red = prs.filter(redOrMissing).map((pr) => `#${pr.number}`);
  if (red.length >= max)
    throw new CliUsageError(
      `open-red limit: ${red.length} open PRs have a red or missing Check (maximum ${max}, KRN_OPEN_RED_MAX): ${red.join(', ')}; fix or close one before starting a lane`,
    );
}
