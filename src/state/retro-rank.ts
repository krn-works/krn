// Ranks retro evidence into recurring causes: items cluster by kind and
// subject (the module for review findings), a cause recurs when it appears
// more than once, and the order is distinct sources (a cause that returns in
// other PRs or sessions), then items, then review rounds.
import type { EvidenceItem, EvidenceKind } from './retro-evidence.ts';

export interface Cause {
  kind: EvidenceKind;
  subject: string;
  count: number;
  /** Distinct sources (transcripts or PRs) the cause appears in. */
  sources: number;
  /** Highest review round reached; 0 for transcript causes. */
  rounds: number;
  pointers: string[];
  example: string;
}

const sourceOf = (pointer: string) => pointer.split(':')[0] as string;

export function rankCauses(items: EvidenceItem[], limit = 10): Cause[] {
  const groups = new Map<string, EvidenceItem[]>();
  for (const item of items) {
    const key = `${item.kind}\u0000${item.subject}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      kind: (group[0] as EvidenceItem).kind,
      subject: (group[0] as EvidenceItem).subject,
      count: group.length,
      sources: new Set(group.map((item) => sourceOf(item.pointer))).size,
      rounds: Math.max(...group.map((item) => item.round)),
      pointers: group.map((item) => item.pointer),
      example: (group[0] as EvidenceItem).text.split('\n')[0] as string,
    }))
    .sort(
      (a, b) =>
        b.sources - a.sources ||
        b.count - a.count ||
        b.rounds - a.rounds ||
        a.subject.localeCompare(b.subject),
    )
    .slice(0, limit);
}

export function renderCauses(causes: Cause[]): string {
  if (causes.length === 0) return 'Recurring causes: none seen more than once';
  return [
    'Recurring causes (ranked; dispose each: check, then rule, then task):',
    ...causes.map(
      (cause, index) =>
        `${index + 1}. [${cause.kind}] ${cause.subject}: ${cause.count}x in ${cause.sources} source(s)${cause.rounds > 0 ? `, ${cause.rounds} review round(s)` : ''}\n   e.g. ${cause.example}\n   at ${cause.pointers.slice(0, 5).join(' ')}${cause.pointers.length > 5 ? ' ...' : ''}`,
    ),
  ].join('\n');
}
