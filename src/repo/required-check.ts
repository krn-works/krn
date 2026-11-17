import {
  REQUIRED_CHECK_APP_ID,
  REQUIRED_CHECK_NAME,
} from './ci-admission-contract.ts';

/** One check run of a head as `gh api repos/<repo>/commits/<sha>/check-runs` reports it, upper-cased status and conclusion. */
export type CheckFact = {
  name?: string;
  appId?: number | null | undefined;
  startedAt?: string | null;
  status?: string | null;
  conclusion?: string | null;
  detailsUrl?: string | null;
};

/** The `--jq` filter that turns the check-runs answer into `CheckFact` rows. */
export const CHECK_FACT_FILTER =
  '[.check_runs[] | {name, appId: .app.id, startedAt: .started_at, status: (.status // "" | ascii_upcase), conclusion: (.conclusion // "" | ascii_upcase), detailsUrl: .details_url}]';

const aggregateName = new RegExp(`(?:^|/ )${REQUIRED_CHECK_NAME}$`, 'u');

/** The aggregate check name, whether its job is `Check` or `<caller job> / Check`. */
export function isRequiredCheckName(name: string | undefined): boolean {
  return aggregateName.test(name ?? '');
}

/**
 * The newest run of the required check: its name is the aggregate name and its App is the required one.
 * A rerun leaves older runs beside it and only the latest speaks for the head (later entry wins a tie).
 */
export function selectRequiredCheck(
  runs: readonly CheckFact[],
): CheckFact | undefined {
  let newest: CheckFact | undefined;
  for (const run of runs) {
    if (run.appId !== REQUIRED_CHECK_APP_ID || !isRequiredCheckName(run.name))
      continue;
    if (
      newest === undefined ||
      (run.startedAt ?? '') >= (newest.startedAt ?? '')
    )
      newest = run;
  }
  return newest;
}

/** Only SUCCESS is green: neutral, skipped, stale and a missing conclusion are not. */
export function isGreen(conclusion: string | null | undefined): boolean {
  return conclusion === 'SUCCESS';
}
