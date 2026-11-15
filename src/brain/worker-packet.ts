// Conventions packet for a lane brief (ADR 0002, FR-40 GO): the arm-B selection over the
// repository's own conventions, prepended to the brief and recorded with the run. The
// records file comes from the repo contract (`conventions`, default .krn/conventions.json);
// a repository without it gets no packet. A record outside its valid dates never enters,
// and a record whose `audience` is `lead` never reaches the worker.
import { createHash } from 'node:crypto';
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
import { readProject } from './standards-cli.ts';

/** Token budget of the one lane packet; the frozen FR-40 arms stay at BUDGET. */
export const LANE_BUDGET = 600;

/** Token budget of the packet SessionStart injects into an interactive session. */
export const SESSION_BUDGET = 400;

/** What a failure of a record costs a worker, so a floor rule outranks an equally matching finish rule. */
export const EFFECT = { floor: 3, reflex: 2, finish: 1 } as const;

/** The effect weight of a record: its tier, reflex when it names none. */
export const tierEffect = (record: BrainRecord): number =>
  EFFECT[record.tier ?? 'reflex'];

/** One prose record in this many is withheld from a task, so its effect can be measured against the tasks that were served it. */
export const HOLDOUT_ONE_IN = 10;

/** True when the record is in the task's holdout: a pure function of task id and record id, so a rerun withholds the same records. */
export function heldOut(task: string, id: string): boolean {
  const digest = createHash('sha256').update(`${task}\0${id}`).digest();
  return digest.readUInt32BE(0) % HOLDOUT_ONE_IN === 0;
}

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

/** Every record a lane packet could carry for this repository: the candidates the packet selects from. */
export function laneCandidates(repo: string): BrainRecord[] {
  const path = recordsPath(repo);
  const own = existsSync(path)
    ? parseRecords(JSON.parse(readFileSync(path, 'utf8')))
    : [];
  const ids = new Set(own.map((record) => record.id));
  const standards = readProject(repo)
    .map(packetRecord)
    .filter((record) => !ids.has(record.id));
  return workerRecords([...own, ...standards]);
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
  holdout = true,
): Packet | null {
  const candidates = laneCandidates(repo);
  if (candidates.length === 0) return null;
  return brainPacket({
    task,
    query: brief,
    records: candidates.filter(
      (record) => !holdout || !heldOut(task, record.id),
    ),
    asOf,
    budget,
    effect: tierEffect,
  });
}

export { clauseSection } from './acceptance-clauses.ts';

/** The brief the worker receives: the packet as a conventions block, then the lead's brief. */
export function packetBrief(packet: Packet | null, brief: string): string {
  if (packet === null || packet.records.length === 0) return brief;
  return `Repository conventions (brain packet ${packet.sha256.slice(0, 12)}):\n${packet.text}\n\n${brief}`;
}
