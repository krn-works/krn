// Conventions packet for a lane brief (ADR 0002, FR-40 GO): the arm-B selection over the
// repository's own conventions, prepended to the brief and recorded with the run. The
// records file comes from the repo contract (`conventions`, default .krn/conventions.json);
// a repository without it gets no packet. A record outside its valid dates never enters,
// and a record whose `audience` is `lead` never reaches the worker.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contractConventions } from '../repo/contract.ts';
import { assertFormat } from '../repo/formats.ts';
import { isUnservedType, readDecisions } from './decisions.ts';
import {
  type BrainRecord,
  brainPacket,
  type Packet,
  packetRecord,
  parseRecords,
  tokens,
} from './packet.ts';
import { parseUnified } from './record.ts';
import {
  appliesTo,
  inForce,
  type Repository,
  type Standard,
} from './standards.ts';
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

const squash = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();

/** The always-loaded rule files of a repository, squashed to words: what the model already holds. */
function alwaysLoaded(repo: string): string {
  return ['AGENTS.md', 'CLAUDE.md']
    .map((name) => join(repo, name))
    .filter((path) => existsSync(path))
    .map((path) => ` ${squash(readFileSync(path, 'utf8'))} `)
    .join('');
}

/** Drops the records AGENTS.md or CLAUDE.md already state, by id or by text: serving them again costs tokens and adds nothing. */
export function withoutAlwaysLoaded(
  repo: string,
  records: readonly BrainRecord[],
): BrainRecord[] {
  const loaded = alwaysLoaded(repo);
  if (loaded === '') return [...records];
  return records.filter(
    (record) =>
      !loaded.includes(` ${squash(record.id)} `) &&
      !loaded.includes(` ${squash(record.text)} `),
  );
}

/** Who a packet is for: a worker never receives a lead record; the lead receives both. */
export type PacketAudience = 'worker' | 'lead';

/** The records a lead's own session may carry: everything but adoption records and enforced records. */
export function leadRecords(records: readonly BrainRecord[]): BrainRecord[] {
  return records.filter(
    (record) => record.audience !== 'adopt' && record.enforced !== true,
  );
}

/** Every record a lane packet could carry for this repository: the candidates the packet selects from. */
export function laneCandidates(
  repo: string,
  audience: PacketAudience = 'worker',
): BrainRecord[] {
  assertFormat(repo, 'krn.record');
  const path = recordsPath(repo);
  const own = existsSync(path)
    ? parseRecords(JSON.parse(readFileSync(path, 'utf8')))
    : [];
  const ids = new Set(own.map((record) => record.id));
  const standards = readProject(repo)
    .map(packetRecord)
    .filter((record) => !ids.has(record.id));
  const all = [...own, ...standards];
  return withoutAlwaysLoaded(
    repo,
    audience === 'lead' ? leadRecords(all) : workerRecords(all),
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
  holdout = true,
  audience: PacketAudience = 'worker',
): Packet | null {
  const candidates = laneCandidates(repo, audience);
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

// Query: the records that apply to what a session is doing now (`krn standards query`).
/** Records one query shows at most, whatever the budget allows. */
export const QUERY_LIMIT = 5;

/** Token budget of one query answer. */
export const QUERY_BUDGET = 400;

/** The task id a query is logged under when the caller names none; an unnamed query has no holdout, since the caller asked for the answer. */
export const QUERY_TASK = 'query';

export const NO_MATCH = 'no matching record';

export type Query = {
  readonly text: string;
  readonly files: readonly string[];
  readonly stack?: string;
  readonly budget?: number;
  readonly task?: string;
  /** Keep only records of this type; a decision, preference or fact is read from the decisions file, which no packet serves. */
  readonly type?: string;
  readonly asOf: string;
};

export type Hit = {
  readonly id: string;
  readonly text: string;
  readonly why: string;
};

/** A glob (`*` within a segment, `**` across segments) as an anchored regular expression. */
function globRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*\*\//gu, '@@DIR@@')
    .replace(/\*\*/gu, '@@ANY@@')
    .replace(/\*/gu, '[^/]*')
    .replace(/@@DIR@@/gu, '(?:.*/)?')
    .replace(/@@ANY@@/gu, '.*');
  return new RegExp(`^${body}$`, 'u');
}

function scoped(
  standard: Standard,
  facts: Repository,
  files: readonly string[],
): boolean {
  if (!appliesTo(standard, facts)) return false;
  const { paths } = standard.applies;
  if (paths.length === 0 || files.length === 0) return true;
  const patterns = paths.map(globRegExp);
  return files.some((file) => patterns.some((pattern) => pattern.test(file)));
}

function conventions(root: string): Standard[] {
  const path = join(root, contractConventions(root));
  return existsSync(path)
    ? parseUnified(JSON.parse(readFileSync(path, 'utf8')))
    : [];
}

export function renderHit(hit: Hit): string {
  return `- [${hit.id}] ${hit.text}${hit.why === '' ? '' : ` (why: ${hit.why})`}`;
}

/** The answer's records, best first, within the budget as printed (id, text and why). */
export function queryStandards(root: string, query: Query): Hit[] {
  const base = repositoryFacts(root);
  const facts: Repository =
    query.stack === undefined ? base : { ...base, stack: query.stack };
  const task = query.task ?? QUERY_TASK;
  const seen = new Set<string>();
  const unserved = query.type !== undefined && isUnservedType(query.type);
  const pool = (
    unserved
      ? readDecisions(root)
      : [...readPack(), ...readProject(root), ...conventions(root)]
  ).filter((standard) => {
    if (seen.has(standard.id)) return false;
    seen.add(standard.id);
    return (
      (query.type === undefined || standard.type === query.type) &&
      standard.audience !== 'lead' &&
      standard.audience !== 'adopt' &&
      inForce(standard, query.asOf) &&
      scoped(standard, facts, query.files)
    );
  });
  const byId = new Map(pool.map((standard) => [standard.id, standard]));
  const records: BrainRecord[] = pool
    .filter(
      (standard) =>
        unserved || query.task === undefined || !heldOut(task, standard.id),
    )
    .map(packetRecord);
  const ranked = brainPacket({
    task,
    query: [query.text, ...query.files].join(' '),
    records,
    asOf: query.asOf,
    budget: Number.MAX_SAFE_INTEGER,
    matchText: (record) => (byId.get(record.id)?.applies.terms ?? []).join(' '),
  }).records;
  const budget = query.budget ?? QUERY_BUDGET;
  const hits: Hit[] = [];
  for (const id of ranked.slice(0, QUERY_LIMIT)) {
    const standard = byId.get(id);
    if (standard === undefined) continue;
    const hit = { id, text: standard.text, why: standard.why };
    if (tokens([...hits, hit].map(renderHit).join('\n')) <= budget)
      hits.push(hit);
  }
  return hits;
}

// Edit moment: the records scoped to the kind of file a session is about to edit.
/** Token budget of the block one edit adds. */
export const EDIT_BUDGET = 150;

const STACK_OF_EXTENSION: Readonly<Record<string, string>> = {
  php: 'php',
  py: 'python',
  go: 'go',
  rs: 'rust',
  ts: 'node',
  tsx: 'node',
  mts: 'node',
  cts: 'node',
  js: 'node',
  jsx: 'node',
  mjs: 'node',
  cjs: 'node',
};

/** The stack a file belongs to by its extension (`php`, `python`, `node`, ...), undefined for any other kind. */
export function fileStack(file: string): string | undefined {
  const dot = file.lastIndexOf('.');
  if (dot < 0 || dot < file.lastIndexOf('/')) return undefined;
  return STACK_OF_EXTENSION[file.slice(dot + 1).toLowerCase()];
}

/**
 * The records scoped to the kind of `file` (repository-relative): those naming a stack the file's
 * extension belongs to or a path pattern the file matches, in force, not addressed to the lead or to
 * adoption, strongest tier first. A record with neither stacks nor paths is session-start material
 * and never returns here.
 */
export function editRecords(
  root: string,
  file: string,
  asOf: string,
): Standard[] {
  const base = repositoryFacts(root);
  const stack = fileStack(file);
  const facts: Repository =
    stack === undefined
      ? { adopted: base.adopted, needs: base.needs }
      : { stack, adopted: base.adopted, needs: base.needs };
  const seen = new Set<string>();
  return [...readPack(), ...readProject(root), ...conventions(root)]
    .filter((standard) => {
      if (seen.has(standard.id)) return false;
      seen.add(standard.id);
      const { stacks, paths } = standard.applies;
      return (
        (stacks.length > 0 || paths.length > 0) &&
        standard.audience !== 'lead' &&
        standard.audience !== 'adopt' &&
        inForce(standard, asOf) &&
        scoped(standard, facts, [file])
      );
    })
    .sort((a, b) => tierEffect(packetRecord(b)) - tierEffect(packetRecord(a)));
}

/** The records of `ranked` whose rendered lines fit `budget` tokens together, in order. */
export function withinBudget(
  ranked: readonly Standard[],
  budget: number,
): Standard[] {
  const kept: Standard[] = [];
  for (const standard of ranked) {
    const next = [...kept, standard];
    if (tokens(next.map(editLine).join('\n')) <= budget) kept.push(standard);
  }
  return kept;
}

/** One record as the edit block prints it. */
export function editLine(standard: Standard): string {
  return `- [${standard.id}] ${standard.text}`;
}
