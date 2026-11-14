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
  brainPacket,
  type Packet,
  packetRecord,
  parseRecords,
} from './packet.ts';
import { standardRecord } from './record.ts';
import { readProject } from './standards-cli.ts';

/** Token budget of the one lane packet; the frozen FR-40 arms stay at BUDGET. */
export const LANE_BUDGET = 600;

/** What a failure of a record costs a worker, so a floor rule outranks an equally matching finish rule. */
export const EFFECT = { floor: 3, reflex: 2, finish: 1 } as const;

/** The effect weight of a record: its tier, reflex when it names none. */
export const tierEffect = (record: BrainRecord): number =>
  EFFECT[record.tier ?? 'reflex'];

/** Where a repository keeps its conventions: the repo contract names the file. */
const recordsPath = (repo: string): string =>
  join(repo, contractConventions(repo));

/**
 * The records a worker's lane packet may carry: not those addressed to the lead or to adoption, and
 * not those a command or krn check enforces (the check teaches them when it fails).
 */
export function workerRecords(records: readonly BrainRecord[]): BrainRecord[] {
  return records.filter(
    (record) =>
      record.audience !== 'lead' &&
      record.audience !== 'adopt' &&
      record.enforced !== true,
  );
}

/**
 * Packet for a lead's lane brief: the one packet of the repository's conventions and its worker
 * standards, ranked by match with the brief's own terms times the effect of the record's tier,
 * within LANE_BUDGET tokens (the FR-40 arm-B carrier selects the same way at the frozen BUDGET). `task` names the unit the
 * packet serves (its digest covers it). A repository without records gets no packet.
 */
export function lanePacket(
  repo: string,
  brief: string,
  asOf: string,
  task: string,
  budget = LANE_BUDGET,
): Packet | null {
  const path = recordsPath(repo);
  const own = existsSync(path)
    ? parseRecords(JSON.parse(readFileSync(path, 'utf8')))
    : [];
  const ids = new Set(own.map((record) => record.id));
  const standards = readProject(repo)
    .map((standard) => packetRecord(standardRecord(standard)))
    .filter((record) => !ids.has(record.id));
  const records = workerRecords([...own, ...standards]);
  if (records.length === 0) return null;
  return brainPacket({
    task,
    query: brief,
    records,
    asOf,
    budget,
    effect: tierEffect,
  });
}

/** The brief the worker receives: the packet as a conventions block, then the lead's brief. */
export function packetBrief(packet: Packet | null, brief: string): string {
  if (packet === null || packet.records.length === 0) return brief;
  return `Repository conventions (brain packet ${packet.sha256.slice(0, 12)}):\n${packet.text}\n\n${brief}`;
}
