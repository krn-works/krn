// Brain packet for a `krn worker` brief (ADR 0002, FR-40 GO): the arm-B selection over the
// seven conventions FR-40 measured, prepended to the brief and recorded with the run.
import { readFileSync } from 'node:fs';
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

const RECORDS = new URL('../../evals/fr40/records.json', import.meta.url);

export function workerPacket(brief: string, asOf: string): Packet {
  const measured = new Set<string>(MEASURED);
  return brainPacket({
    task: 'worker-brief',
    query: brief,
    records: parseRecords(JSON.parse(readFileSync(RECORDS, 'utf8'))).filter(
      (record) => measured.has(record.id),
    ),
    asOf,
    budget: BUDGET,
  });
}

/** The brief the worker receives: the packet as a conventions block, then the lead's brief. */
export function packetBrief(packet: Packet, brief: string): string {
  if (packet.records.length === 0) return brief;
  return `Repository conventions (brain packet ${packet.sha256.slice(0, 12)}):\n${packet.text}\n\n${brief}`;
}
