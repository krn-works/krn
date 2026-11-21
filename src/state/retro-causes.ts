// Composes the retro's ranked causes: the last N transcripts and the review
// comments of the last merged PRs, ranked.

import { git } from './git.ts';
import {
  type EvidenceItem,
  readTranscript,
  recentTranscripts,
} from './retro-evidence.ts';
import { rankCauses, renderCauses } from './retro-rank.ts';

/** Transcripts are filed under the main checkout's path, never a linked worktree's. */
function mainCheckout(root: string): string {
  const list = git(root, ['worktree', 'list', '--porcelain']);
  return (list.ok ? /^worktree (.+)$/m.exec(list.out)?.[1] : undefined) ?? root;
}

export function renderRetroCauses(
  root: string,
  sessions: number,
  projects: string,
  review: EvidenceItem[],
  transcripts = recentTranscripts(mainCheckout(root), sessions, projects),
): string {
  const items = [
    ...transcripts.flatMap((path) => readTranscript(path)),
    ...review,
  ];
  return `Evidence: ${transcripts.length} transcript(s), ${review.length} review finding(s)\n${renderCauses(rankCauses(items))}`;
}
