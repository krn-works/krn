// What a claim opens with: the repository clauses that match the claimed task's brief, stack and
// area, and the top precedent file, within one token budget; the served clause ids are stored
// beside the claim so the closing PR can write exposure rows for them.
import { tokens } from './packet.ts';
import { siblingSection } from './precedent.ts';
import { taskKey, taskQueryText } from './task-query.ts';
import { lanePacket } from './worker-packet.ts';

/** Token budget of everything `krn task claim` prints about the task. */
export const CLAIM_PACKET_BUDGET = 400;

export interface ClaimPacket {
  /** The ids of the clauses served, in print order. */
  clauses: string[];
  /** The top sibling file matched by the task's goal identifiers. */
  precedent: string | null;
  text: string;
}

const FIRST_SIBLING = /^- `([^`]+)`$/mu;
const HEAD = 'Clauses for this task:';

/**
 * The packet of one open task, or undefined when the task keys nothing or neither a clause nor a
 * precedent matches. The text stays within CLAIM_PACKET_BUDGET tokens.
 */
export function claimPacket(
  root: string,
  id: string,
  asOf: string = new Date().toISOString().slice(0, 10),
): ClaimPacket | undefined {
  const key = taskKey(root, id);
  if (key === undefined) return undefined;
  const query = taskQueryText(key, []);
  const precedent =
    FIRST_SIBLING.exec(siblingSection(root, query))?.[1] ?? null;
  const precedentLine =
    precedent === null
      ? ''
      : `Precedent (stack and area match): \`${precedent}\``;
  const room = CLAIM_PACKET_BUDGET - tokens(`${HEAD}\n\n${precedentLine}`) - 1;
  const packet = room > 0 ? lanePacket(root, query, asOf, id, room) : null;
  const clauses = packet === null ? [] : [...packet.records];
  if (clauses.length === 0 && precedent === null) return undefined;
  const text = [
    ...(packet === null || clauses.length === 0 ? [] : [HEAD, packet.text]),
    ...(precedentLine === '' ? [] : [precedentLine]),
  ].join('\n');
  return { clauses, precedent, text };
}
