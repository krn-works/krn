// Conventions packet for a lane brief (ADR 0002, FR-40 GO): the arm-B selection over the
// repository's own conventions, prepended to the brief and recorded with the run. The
// records file comes from the repo contract (`conventions`, default .krn/conventions.json);
// a repository without it gets no packet. A record outside its valid dates never enters,
// and a record whose `audience` is `lead` never reaches the worker.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contractConventions } from '../repo/contract.ts';
import {
  type BrainRecord,
  BUDGET,
  brainPacket,
  type Packet,
  parseRecords,
} from './packet.ts';

/** Where a repository keeps its conventions: the repo contract names the file. */
const recordsPath = (repo: string): string =>
  join(repo, contractConventions(repo));

/** The records a worker's lane packet may carry: every record but those addressed to the lead. */
export function workerRecords(records: readonly BrainRecord[]): BrainRecord[] {
  return records.filter((record) => record.audience !== 'lead');
}

/**
 * Packet for a lead's lane brief: the carrier FR-40's Claude lane run measured (arm B,
 * `evals/fr40/lanes.ts` laneBrief), a selection over every record of the repository by the
 * brief's own terms, without records addressed to the lead. `task` names the unit the
 * packet serves (its digest covers it). A repository without records gets no packet.
 */
export function lanePacket(
  repo: string,
  brief: string,
  asOf: string,
  task: string,
): Packet | null {
  const path = recordsPath(repo);
  if (!existsSync(path)) return null;
  return brainPacket({
    task,
    query: brief,
    records: workerRecords(
      parseRecords(JSON.parse(readFileSync(path, 'utf8'))),
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
