// Composes the retro's ranked causes: the last N transcripts and the review
// comments of the last merged PRs, ranked.

import { git } from './git.ts';
import {
  type EvidenceItem,
  readTranscript,
  recentTranscripts,
} from './retro-evidence.ts';
import { rankCauses, renderCauses } from './retro-rank.ts';

/** Every checkout of the repository (main and linked worktrees): transcripts are filed under each one's path. */
function checkouts(root: string): string[] {
  const list = git(root, ['worktree', 'list', '--porcelain']);
  const paths = list.ok
    ? [...list.out.matchAll(/^worktree (.+)$/gm)].map((m) => m[1] as string)
    : [];
  return [...new Set([root, ...paths])];
}

export function renderRetroCauses(
  root: string,
  sessions: number,
  projects: string,
  review: EvidenceItem[],
  transcripts = recentTranscripts(checkouts(root), sessions, projects),
): string {
  const items = [
    ...transcripts.flatMap((path) => readTranscript(path)),
    ...review,
  ];
  return `Evidence: ${transcripts.length} transcript(s), ${review.length} review finding(s)\n${renderCauses(rankCauses(items))}`;
}
