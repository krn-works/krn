import { z } from 'zod';
import { REQUIRED_CHECK_APP_ID } from '../repo/ci-admission-contract.ts';
import {
  type CheckFact,
  isGreen,
  selectRequiredCheck,
  supersededByRerun,
} from '../repo/required-check.ts';

/**
 * The state of one pull request head, as one closed set. Ship, the open-red limit and the lane
 * receiver branch on this state, never on raw gh fields: each GitHub surprise is one fixture here.
 */
export const PR_STATES = [
  'merged',
  'closed',
  'updating',
  'head-moved',
  'conflict',
  'no-check',
  'queued',
  'running',
  'superseded',
  'red',
  'green',
  'merging',
] as const;

export type PrState =
  /** The PR merged at the expected head. */
  | { kind: 'merged'; mergeCommit: string }
  | { kind: 'closed' }
  /** The PR still reports the head a branch update replaced: GitHub has not seen the push yet. */
  | { kind: 'updating'; shows: string }
  /** The PR is at, or merged at, another head than the expected one. */
  | { kind: 'head-moved'; at: string; merged: boolean }
  | { kind: 'conflict' }
  | CheckState
  /** Green, and a merge of this head was requested: waiting for GitHub to report MERGED. */
  | { kind: 'merging'; check: CheckFact; run: string | undefined };

/** The state of the required check of one head, with or without a PR. */
type CheckState =
  /** No run of the required context, and nothing of the head is still running. */
  | { kind: 'no-check' }
  /** No run of the required context yet, but a job or workflow run of the head has not completed. */
  | { kind: 'queued' }
  /** The newest required run has not concluded. */
  | { kind: 'running'; check: CheckFact }
  /** The newest required run concluded, but a rerun of its Actions run is still going. */
  | { kind: 'superseded'; check: CheckFact }
  /** The newest required run concluded anything but SUCCESS (KRN-07: only SUCCESS is green). */
  | {
      kind: 'red';
      check: CheckFact;
      conclusion: string;
      run: string | undefined;
    }
  | { kind: 'green'; check: CheckFact; run: string | undefined };

/** The fields of `gh pr view <n> --json <fields>` the state reads. */
export const PR_VIEW_FIELDS = 'state,headRefOid,mergeable,mergeCommit';

const viewSchema = z.object({
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  headRefOid: z.string(),
  mergeable: z.string().optional(),
  mergeCommit: z.object({ oid: z.string() }).nullish(),
});
/** The rows `CHECK_FACT_FILTER` prints: every key present, null or "" when GitHub has no value. */
const checkRunsSchema = z.array(
  z.object({
    id: z.number().nullable(),
    name: z.string(),
    appId: z.number().nullable(),
    startedAt: z.string().nullable(),
    status: z.string(),
    conclusion: z.string(),
    detailsUrl: z.string().nullable(),
  }),
);
const runsSchema = z.array(z.object({ status: z.string() }));

/** What the caller pushed and asked for: the state is relative to it. */
export type Expected = {
  /** The head the caller judges. */
  head: string;
  /** The head a branch update replaced; the PR may report it until GitHub sees the push. */
  replaced?: string | undefined;
  /** The required context: `Check` unless the branch rules name another. */
  context: string;
  /** Whether a merge of `head` was requested (or GitHub answered that one is in progress). */
  mergeRequested: boolean;
};

const runOf = (check: CheckFact) =>
  /\/runs\/(\d+)/u.exec(check.detailsUrl ?? '')?.[1];

function checkState(
  checkRuns: readonly CheckFact[],
  runs: readonly { status: string }[],
  context: string,
): CheckState {
  const check = selectRequiredCheck(checkRuns, context);
  if (check === undefined)
    // A job of the required App or a listed workflow run still going is a Check that has not
    // registered yet; a red-by-design `<caller> / Check` that finished first never stands in for it.
    return checkRuns.some(
      (run) =>
        run.appId === REQUIRED_CHECK_APP_ID && run.status !== 'COMPLETED',
    ) || runs.some((run) => run.status.toLowerCase() !== 'completed')
      ? { kind: 'queued' }
      : { kind: 'no-check' };
  if (check.status !== 'COMPLETED') return { kind: 'running', check };
  if (supersededByRerun(check, checkRuns)) return { kind: 'superseded', check };
  const conclusion = check.conclusion || undefined;
  if (conclusion === undefined) return { kind: 'running', check };
  return isGreen(conclusion)
    ? { kind: 'green', check, run: runOf(check) }
    : { kind: 'red', check, conclusion, run: runOf(check) };
}

/**
 * The one state of a PR head, pure over what gh printed for it at one moment. An answer left
 * out was not read: no check runs, no listed runs. A malformed answer throws.
 */
export function classify(
  answers: {
    /** `gh pr view <n> --json state,headRefOid,mergeable,mergeCommit` (more fields are ignored). */
    view: string;
    /** `gh api repos/<repo>/commits/<head>/check-runs?filter=all&per_page=100 --jq CHECK_FACT_FILTER`. */
    checkRuns?: string | undefined;
    /** `gh run list --repo <repo> --commit <head> --json status`. */
    runs?: string | undefined;
  },
  expected: Expected,
): PrState {
  const view = viewSchema.parse(JSON.parse(answers.view));
  if (view.state === 'MERGED')
    return view.headRefOid === expected.head
      ? { kind: 'merged', mergeCommit: view.mergeCommit?.oid ?? 'unknown' }
      : { kind: 'head-moved', at: view.headRefOid, merged: true };
  if (view.state === 'CLOSED') return { kind: 'closed' };
  if (expected.replaced !== undefined && view.headRefOid === expected.replaced)
    return { kind: 'updating', shows: view.headRefOid };
  if (view.headRefOid !== expected.head)
    return { kind: 'head-moved', at: view.headRefOid, merged: false };
  if (view.mergeable === 'CONFLICTING') return { kind: 'conflict' };
  const check = checkState(
    checkRunsSchema.parse(JSON.parse(answers.checkRuns ?? '[]')),
    runsSchema.parse(JSON.parse(answers.runs ?? '[]')),
    expected.context,
  );
  return check.kind === 'green' && expected.mergeRequested
    ? { kind: 'merging', check: check.check, run: check.run }
    : check;
}
