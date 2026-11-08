// Brain packet for a `krn worker` brief (ADR 0002, FR-40 GO): the arm-B selection over the
// seven conventions FR-40 measured, prepended to the brief and recorded with the run.
// The records are the target repository's own: a repository without them gets no packet.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUDGET, brainPacket, type Packet, parseRecords } from './packet.ts';

/** The records of the seven measured conventions; a wider pool needs a wider run. */
export const MEASURED = [
  'r-commit-title-id',
  'r-trailer',
  'r-agent-state',
  'r-tracker-owner',
  'r-core-imports',
  'r-role-names',
  'r-biome-clean',
] as const;

/** Where a repository keeps the records FR-40 measured. */
export const RECORDS = 'evals/fr40/records.json';

export function workerPacket(
  repo: string,
  brief: string,
  asOf: string,
): Packet | null {
  const path = join(repo, RECORDS);
  if (!existsSync(path)) return null;
  const measured = new Set<string>(MEASURED);
  return brainPacket({
    task: 'worker-brief',
    query: brief,
    records: parseRecords(JSON.parse(readFileSync(path, 'utf8'))).filter(
      (record) => measured.has(record.id),
    ),
    asOf,
    budget: BUDGET,
  });
}

/** The brief the worker receives: the packet as a conventions block, then the lead's brief. */
export function packetBrief(packet: Packet | null, brief: string): string {
  if (packet === null || packet.records.length === 0) return brief;
  return `Repository conventions (brain packet ${packet.sha256.slice(0, 12)}):\n${packet.text}\n\n${brief}`;
}
