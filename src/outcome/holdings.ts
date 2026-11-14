// Who held the window's dollars: delivery lead, lanes, other subagents, and sessions that deliver nothing.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Transcript } from './slice-cost.ts';

export const HOLDINGS = [
  'delivery lead',
  'delivery lanes',
  'delivery other subagents',
  'non-delivery: architecture program',
  'non-delivery: other',
] as const;
export type Holding = (typeof HOLDINGS)[number];
// `lane` marks a headless `krn lane run` session: lane cost, never lead cost.
type SessionClass = 'delivery' | 'non-delivery' | 'lane';

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
      const row = sessionMarkSchema.safeParse(JSON.parse(line));
      if (row.success) marks.set(row.data.session, row.data.class);
    } catch {
      /* A torn or blank line hides nothing else. */
    }
  }
  return marks;
}

/** One row of .krn/operator/sessions.jsonl, written by the operator's session marker. */
export const sessionMarkSchema = z.looseObject({
  session: z.string(),
  class: z.enum(['delivery', 'non-delivery', 'lane']),
});

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
const isLane = (sub: Transcript): boolean =>
  sub.turns.some((t) => laneCommand.test(t.text));

export function holdingOf(
  lead: { class: SessionClass; program: boolean },
  sub: Transcript | null,
): Holding {
  if (lead.class === 'lane') return 'delivery lanes';
  if (lead.class === 'non-delivery')
    return lead.program
      ? 'non-delivery: architecture program'
      : 'non-delivery: other';
  if (sub === null) return 'delivery lead';
  return isLane(sub) ? 'delivery lanes' : 'delivery other subagents';
}
