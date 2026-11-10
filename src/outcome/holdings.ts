// Who held the window's dollars: delivery lead, lanes, other subagents, and sessions that deliver nothing.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Transcript } from './slice-cost.ts';

export const HOLDINGS = [
  'delivery lead',
  'delivery lanes',
  'delivery other subagents',
  'non-delivery: architecture program',
  'non-delivery: other',
] as const;
export type Holding = (typeof HOLDINGS)[number];
export type SessionClass = 'delivery' | 'non-delivery';

/** Launchers record each session's class once in `.krn/operator/sessions.jsonl`. */
export async function sessionMarkers(
  root: string,
): Promise<Map<string, SessionClass>> {
  const marks = new Map<string, SessionClass>();
  let text = '';
  try {
    text = await readFile(join(root, '.krn/operator/sessions.jsonl'), 'utf8');
  } catch {
    return marks;
  }
  for (const line of text.split('\n')) {
    try {
      const row = JSON.parse(line) as { session?: unknown; class?: unknown };
      if (
        typeof row.session === 'string' &&
        (row.class === 'delivery' || row.class === 'non-delivery')
      )
        marks.set(row.session, row.class);
    } catch {
      /* A torn or blank line hides nothing else. */
    }
  }
  return marks;
}

const launcherPrompt = /^First run `node scripts\/claude\/successor-launch\.ts/;
const programPrompt =
  /krn-architecture-program|architecture program|architecture lead/i;

/**
 * A marked session keeps its marker. History before the marker is classed by
 * its first prompt: the launcher's opening sentence is a delivery lead and any
 * other prompt delivers nothing. Those rows are labelled estimated.
 */
export function classifyLead(
  marker: SessionClass | undefined,
  firstPrompt: string,
): { class: SessionClass; estimated: boolean; program: boolean } {
  const estimated = marker === undefined;
  const cls =
    marker ?? (launcherPrompt.test(firstPrompt) ? 'delivery' : 'non-delivery');
  return { class: cls, estimated, program: programPrompt.test(firstPrompt) };
}

/** A lane works in a worktree: it starts one or changes into one, by path. */
const laneCommand =
  /\bkrn lane start\b|\bcd\s+\S*\.krn\/worktrees\/|git -C\s+\S*\.krn\/worktrees\//;
export const isLane = (sub: Transcript): boolean =>
  sub.turns.some((t) => laneCommand.test(t.text));

export function holdingOf(
  lead: { class: SessionClass; program: boolean },
  sub: Transcript | null,
): Holding {
  if (lead.class === 'non-delivery')
    return lead.program
      ? 'non-delivery: architecture program'
      : 'non-delivery: other';
  if (sub === null) return 'delivery lead';
  return isLane(sub) ? 'delivery lanes' : 'delivery other subagents';
}
