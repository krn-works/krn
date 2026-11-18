// The merge convention of every repository, as GitHub repository settings: squash only, the squash
// commit is the PR title and body, the branch goes on merge and auto-merge waits on the required
// check. `krn repo settings` reports the gaps from `gh api repos/{owner}/{repo}` and, with --apply,
// sets them with one `gh api -X PATCH`.

/** Each setting and the value the convention needs. */
export const MERGE_SETTINGS = {
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  squash_merge_commit_title: 'PR_TITLE',
  squash_merge_commit_message: 'PR_BODY',
  delete_branch_on_merge: true,
  allow_auto_merge: true,
} as const;

export type MergeSetting = keyof typeof MERGE_SETTINGS;

export interface SettingGap {
  key: MergeSetting;
  want: boolean | string;
  have: unknown;
}

export class MergeSettingsError extends Error {}

/** The settings of a `gh api repos/{owner}/{repo}` reply that differ from the convention. */
export function mergeSettingGaps(reply: string): SettingGap[] {
  let repo: Record<string, unknown>;
  try {
    repo = JSON.parse(reply) as Record<string, unknown>;
  } catch {
    throw new MergeSettingsError('gh api reply is not JSON');
  }
  if (typeof repo !== 'object' || repo === null || !('full_name' in repo))
    throw new MergeSettingsError('gh api reply is not a repository');
  return (Object.keys(MERGE_SETTINGS) as MergeSetting[])
    .filter((key) => repo[key] !== MERGE_SETTINGS[key])
    .map((key) => ({ key, want: MERGE_SETTINGS[key], have: repo[key] }));
}

/** The `gh api` arguments that set every gap: one PATCH with a typed field each. */
export function applyArgs(path: string, gaps: SettingGap[]): string[] {
  return [
    'api',
    '-X',
    'PATCH',
    path,
    ...gaps.flatMap((gap) => [
      typeof gap.want === 'boolean' ? '-F' : '-f',
      `${gap.key}=${gap.want}`,
    ]),
  ];
}
