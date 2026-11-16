// The claim's packet seam: the task layer asks a source for the clauses and precedent of a claimed
// task (the brain builds them) and stores the served clause ids beside the claim, so the closing PR
// can write exposure rows for them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mainCheckoutRoot } from './claims.ts';
import type { TaskId } from './record.ts';

export interface ClaimPacket {
  /** The ids of the clauses served, in print order. */
  clauses: string[];
  /** The top sibling file matched by the task's goal identifiers. */
  precedent: string | null;
  text: string;
}

/** Builds the packet of one claimed task; undefined when nothing matches. */
export type ClaimPacketSource = (
  root: string,
  id: TaskId,
) => ClaimPacket | undefined;

/** Stores the served clause ids of a claim beside the claim, in the main checkout's ignored claim directory. */
export function storeClauses(
  root: string,
  id: TaskId,
  packet: ClaimPacket,
): string {
  const directory = join(mainCheckoutRoot(root), '.krn', 'task-claims');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${id}.clauses`);
  writeFileSync(
    path,
    `${JSON.stringify({ id, clauses: packet.clauses, precedent: packet.precedent })}\n`,
  );
  return path;
}
