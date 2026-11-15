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
  tokens,
} from './packet.ts';
import { appliesTo, inForce } from './standards.ts';
import { readPack, readProject, repositoryFacts } from './standards-cli.ts';

/** Token budget of the one lane packet; the frozen FR-40 arms stay at BUDGET. */
export const LANE_BUDGET = 600;

/** Token budget of the gates block a lane brief names before the work starts. */
export const GATES_BUDGET = 150;

/** The one command that runs every gate the block names. */
export const GATES_COMMAND = 'krn standards check';

/** The command a worker runs before Stop: the enforced records its diff breaks, with file:line. */
export const REVIEW_COMMAND = 'krn standards review';

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

/**
 * The gates block: the enforced floor and finish records that apply to this repository's stack and
 * are in force, named by id (floor first, then finish, each by id) within GATES_BUDGET tokens, with
 * the one command that runs them. The lane packet omits enforced records because the check teaches
 * them when it fails; this block names them before the work, so a refused Stop is never the first
 * time a worker meets a gate. Undefined when no such record applies.
 */
export function gatesBlock(repo: string, asOf: string): string | undefined {
  let ids: string[];
  try {
    const repository = repositoryFacts(repo);
    const gates = [
      ...readPack().filter((standard) => appliesTo(standard, repository)),
      ...readProject(repo),
    ].filter(
      (standard) =>
        standard.enforcement.kind !== 'advisory' &&
        (standard.tier === 'floor' || standard.tier === 'finish') &&
        standard.audience !== 'lead' &&
        standard.audience !== 'adopt' &&
        inForce(standard, asOf),
    );
    const rank = (tier: string): number => (tier === 'floor' ? 0 : 1);
    ids = [
      ...new Set(
        gates
          .sort(
            (a, b) =>
              rank(a.tier) - rank(b.tier) ||
              (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          )
          .map((standard) => standard.id),
      ),
    ];
  } catch {
    return undefined;
  }
  if (ids.length === 0) return undefined;
  const head = `Before Stop, run '${REVIEW_COMMAND}': it prints file:line for each violation in your diff.\nGates run at Stop (check them with '${GATES_COMMAND}'): `;
  const kept: string[] = [];
  for (const id of ids) {
    const next = `${head}${[...kept, id].join(', ')}`;
    if (tokens(next) > GATES_BUDGET) break;
    kept.push(id);
  }
  return kept.length === 0 ? undefined : `${head}${kept.join(', ')}`;
}
