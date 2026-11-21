// Composes the retro's ranked causes from transcript lines and review findings it is handed.
import { git } from './git.ts';
import { type EvidenceItem, readTranscript } from './retro-evidence.ts';
import { rankCauses, renderCauses } from './retro-rank.ts';

export interface Session {
  name: string;
  lines: readonly string[];
}

/** Every checkout of the repository (main and linked worktrees): transcripts are filed under each one's path. */
export function checkouts(root: string): string[] {
  const list = git(root, ['worktree', 'list', '--porcelain']);
  const paths = list.ok
    ? [...list.out.matchAll(/^worktree (.+)$/gm)].map((m) => m[1] as string)
    : [];
  return [...new Set([root, ...paths])];
}

export function renderRetroCauses(
  sessions: readonly Session[],
  review: EvidenceItem[],
): string {
  const items = [
    ...sessions.flatMap((session) =>
      readTranscript(session.lines, session.name),
    ),
    ...review,
  ];
  return `Evidence: ${sessions.length} transcript(s), ${review.length} review finding(s)\n${renderCauses(rankCauses(items))}`;
}
