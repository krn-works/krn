// The one owner of the commit subject and PR title format, in every repository an agent works in:
// `type(scope): outcome`, outcome lowercase-first, no trailing period, at most SUBJECT_MAX characters
// before the optional ` (t-id)` and ` (#N)` suffixes. A squash merge makes the PR title the commit
// subject on main, so CI checks the title and the agent hook checks `git commit` and `gh pr`.
export const TYPES = [
  'feat',
  'fix',
  'docs',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
] as const;

/** Longest subject, counted without the ` (t-id)` and ` (#N)` suffixes. */
export const SUBJECT_MAX = 100;

/** The expected form, shown in every refusal. */
export const TITLE_FORM =
  'type(scope): outcome, e.g. "fix(web): a cached page no longer shows stale prices"';

const head = new RegExp(
  `^(${TYPES.join('|')})(\\([a-z0-9][a-z0-9_.-]*\\))?!?: (\\S.*)$`,
  'u',
);
const suffixes = /(?: \(t-[a-z0-9]{7}\))?(?: \(#\d+\))?$/u;

export function titleProblem(title: string): string | undefined {
  const subject = title.replace(suffixes, '');
  const match = head.exec(subject);
  const outcome = match?.[3];
  if (outcome === undefined)
    return `"${title}" is not ${TITLE_FORM}; type is one of ${TYPES.join(', ')}`;
  if (/^[A-Z][a-z]/u.test(outcome))
    return `"${title}": the outcome starts lowercase (${TITLE_FORM})`;
  if (outcome.endsWith('.'))
    return `"${title}": the subject has no trailing period (${TITLE_FORM})`;
  if (subject.length > SUBJECT_MAX)
    return `"${title}": the subject is ${subject.length} characters, at most ${SUBJECT_MAX} before the (t-id) or (#N) suffix (${TITLE_FORM})`;
  return undefined;
}
