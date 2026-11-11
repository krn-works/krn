// Brain packet for a lane brief (ADR 0002, FR-40 GO): the arm-B selection over the
// seven conventions FR-40 measured, prepended to the brief and recorded with the run.
// The records are the target repository's own: a repository without them gets no packet.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type BrainRecord,
  BUDGET,
  brainPacket,
  type Packet,
  parseRecords,
} from './packet.ts';

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

const NEEDS_TASK_ID = /\btask id\b|<id>/u;
const TASK_ID = /\bt-[a-z0-9]{7}\b/u;

/**
 * The measured records that apply to a brief. A record that governs a task id (`task id`,
 * `<id>`) applies only when the brief names one: FR-40 agent-state units without a task id
 * invented tracker files or withheld their commit after reading one. The frozen FR-40
 * material keeps the measured selection; this filter is the worker's.
 */
export function applicable(
  records: readonly BrainRecord[],
  brief: string,
): BrainRecord[] {
  const measured = new Set<string>(MEASURED);
  const hasTaskId = TASK_ID.test(brief);
  return records.filter(
    (record) =>
      measured.has(record.id) &&
      (hasTaskId || !NEEDS_TASK_ID.test(record.text)),
  );
}

/** Where a repository keeps the records FR-40 measured. */
const RECORDS = 'evals/fr40/records.json';

/**
 * Live wording that supersedes a frozen record of the same id. evals/fr40/records.json is
 * pinned by the FR-40 manifest hash, so a convention reworded for lane sessions lives here.
 */
const LIVE_RECORDS = 'docs/program/live-records.json';

/** The frozen records with each live record replacing the frozen one of its id. */
export function liveRecords(repo: string): BrainRecord[] {
  const frozen = parseRecords(
    JSON.parse(readFileSync(join(repo, RECORDS), 'utf8')),
  );
  const path = join(repo, LIVE_RECORDS);
  if (!existsSync(path)) return frozen;
  const live = parseRecords(JSON.parse(readFileSync(path, 'utf8')));
  const byId = new Map(live.map((record) => [record.id, record]));
  return frozen.map((record) => byId.get(record.id) ?? record);
}

export function workerPacket(
  repo: string,
  brief: string,
  asOf: string,
): Packet | null {
  const path = join(repo, RECORDS);
  if (!existsSync(path)) return null;
  return brainPacket({
    task: 'worker-brief',
    query: brief,
    records: applicable(liveRecords(repo), brief),
    asOf,
    budget: BUDGET,
  });
}

/**
 * Packet for a lead's lane brief: the carrier FR-40's Claude lane run measured (arm B,
 * `evals/fr40/lanes.ts` laneBrief), a selection over every record of the repository by the
 * brief's own terms, without the worker's measured-record filter. `task` names the unit the
 * packet serves (its digest covers it). A repository without records gets no packet.
 */
export function lanePacket(
  repo: string,
  brief: string,
  asOf: string,
  task: string,
): Packet | null {
  const path = join(repo, RECORDS);
  if (!existsSync(path)) return null;
  return brainPacket({
    task,
    query: brief,
    records: liveRecords(repo),
    asOf,
    budget: BUDGET,
  });
}

/** The brief the worker receives: the packet as a conventions block, then the lead's brief. */
export function packetBrief(packet: Packet | null, brief: string): string {
  if (packet === null || packet.records.length === 0) return brief;
  return `Repository conventions (brain packet ${packet.sha256.slice(0, 12)}):\n${packet.text}\n\n${brief}`;
}
