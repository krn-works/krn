// Deterministic brain packets (ADR 0002 records, ADR 0014 D32 shadow packets): select the records
// valid at an as-of date that best match a task's text, within a fixed token budget.
import { createHash } from 'node:crypto';
import { parseUnified, type UnifiedRecord } from './record.ts';

/** ADR 0002 minimal record shape. Dates are ISO `YYYY-MM-DD`. */
export type BrainRecord = {
  readonly id: string;
  readonly type: string;
  readonly text: string;
  readonly recorded_at: string;
  readonly valid_from: string;
  readonly valid_to: string | null;
  readonly source: string;
  /** Who the record addresses: `lead` keeps it out of the lane packet a worker receives; absent means everyone. */
  readonly audience?: Audience;
  /** True only for a rule that holds in any repository and any stack; `krn standards install --global` writes exactly these. */
  readonly universal?: true;
  /** How a failure weighs: floor outranks reflex outranks finish when the packet ranks by match times effect. */
  readonly tier?: 'floor' | 'reflex' | 'finish';
  /** True when a command or krn check enforces the record; the check teaches it, so a lane packet omits it. */
  readonly enforced?: true;
  /** Status `retired`: never enters a packet. */
  readonly retired?: true;
  /** The record's retrieval terms (`applies.terms`): words a task may use that the text does not, matched like the text itself. */
  readonly terms?: readonly string[];
};

export type Audience = 'lead' | 'worker' | 'adopt';

export type Arm = 'brain' | 'static';

export type Packet = {
  readonly arm: Arm;
  readonly task: string;
  readonly asOf: string;
  readonly budget: number;
  readonly tokens: number;
  readonly records: readonly string[];
  readonly text: string;
  readonly sha256: string;
};

class BrainDataError extends Error {
  readonly exitCode = 65;
}

/** Rejects anything but a list of records of the one schema (src/brain/record.ts) with unique ids and ordered dates; returns the packet view of each. */
export function parseRecords(value: unknown): BrainRecord[] {
  let records: UnifiedRecord[];
  try {
    records = parseUnified(value);
  } catch (error) {
    throw new BrainDataError((error as Error).message);
  }
  return records.map(packetRecord);
}

/** The packet view of one record of the one schema. */
export function packetRecord(r: UnifiedRecord): BrainRecord {
  return {
    id: r.id,
    type: r.type,
    text: r.text,
    recorded_at: r.recorded_at,
    valid_from: r.valid_from,
    valid_to: r.valid_to,
    source: r.provenance.origin,
    tier: r.tier,
    ...(r.audience === 'all' ? {} : { audience: r.audience }),
    ...(r.enforcement.kind === 'advisory' ? {} : { enforced: true as const }),
    ...(r.universal === true ? { universal: true as const } : {}),
    ...(r.applies.terms.length === 0 ? {} : { terms: r.applies.terms }),
    ...(r.status === 'retired' ? { retired: true as const } : {}),
  };
}

/** Token budget FR-40 measured for both arms (frozen material); equality is checked by test/brain/packet.test.ts. */
export const BUDGET = 400;

/** Records one retrieval moment serves at most (ADR 0021 point 10: curated sets of 2 to 3 help, comprehensive sets hurt; SkillsBench arXiv 2602.12670). */
export const SERVE_CAP = 3;

/**
 * Least match score a record needs to be served. A matching term weighs ln(N/df) + 1, never less than 1,
 * so 2 means at least two distinct task terms hit the record: one shared word is the false-positive mode
 * of free retrieval, which lowers the solve rate (-4 pp vs +8 pp for oracle retrieval, SWE-ContextBench
 * arXiv 2602.08316; ADR 0021 point 10). A record under it is withheld, never padded in.
 */
export const CONFIDENCE_THRESHOLD = 2;

/** The one line every serving moment prints so the reader sees the cap and the gate that bounded the answer. */
export const SERVE_POLICY = `at most ${SERVE_CAP} records, retrieval confidence >= ${CONFIDENCE_THRESHOLD}`;

/** Budget unit shared by both arms: four characters per token, rounded up. */
export function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const STOP = new Set(
  'the and for with that this from into your when then are you its not any all one has was will under each'.split(
    ' ',
  ),
);

function terms(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z][a-z0-9]+/gu) ?? []).filter(
      (word) => word.length > 2 && !STOP.has(word),
    ),
  );
}

/** Known at `asOf`: recorded on or before it and valid on it. */
function known(record: BrainRecord, asOf: string): boolean {
  return (
    record.retired !== true &&
    record.recorded_at <= asOf &&
    record.valid_from <= asOf &&
    (record.valid_to === null || record.valid_to >= asOf)
  );
}

function digest(fields: Omit<Packet, 'sha256'>): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function line(record: BrainRecord): string {
  return `- [${record.id}] ${record.text}`;
}

/**
 * Arm B: rank known records by IDF-weighted term overlap with the task text (ties by id),
 * then add them greedily while the packet stays within the budget.
 */
export function brainPacket(input: {
  readonly task: string;
  readonly query: string;
  readonly records: readonly BrainRecord[];
  readonly asOf: string;
  readonly budget: number;
  /** Multiplies a record's match score (default 1: pure match, the FR-40 arm). */
  readonly effect?: (record: BrainRecord) => number;
  /** Extra words a record answers to besides its text (its scope terms); absent: the text alone. */
  readonly matchText?: (record: BrainRecord) => string;
  /** Serve at most this many records (absent: the budget alone bounds the packet, the FR-40 arm). */
  readonly limit?: number;
  /** Serve only records whose match score, before `effect`, reaches this (absent: any match). */
  readonly minMatch?: number;
}): Packet {
  const pool = input.records.filter((record) => known(record, input.asOf));
  const bags = new Map(
    pool.map((record) => [
      record.id,
      terms(
        `${record.text} ${(record.terms ?? []).join(' ')} ${input.matchText?.(record) ?? ''}`,
      ),
    ]),
  );
  const frequency = new Map<string, number>();
  for (const bag of bags.values())
    for (const term of bag) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const query = terms(input.query);
  const match = (record: BrainRecord): number => {
    let total = 0;
    for (const term of bags.get(record.id) ?? [])
      if (query.has(term))
        total += Math.log(pool.length / (frequency.get(term) ?? 1)) + 1;
    return total;
  };
  const ranked = pool
    .map((record) => ({
      record,
      match: match(record),
      score: match(record) * (input.effect?.(record) ?? 1),
    }))
    .filter((entry) => entry.score > 0 && entry.match >= (input.minMatch ?? 0))
    .sort(
      (a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id),
    );
  const chosen: BrainRecord[] = [];
  for (const { record } of ranked) {
    if (chosen.length >= (input.limit ?? Number.POSITIVE_INFINITY)) break;
    const next = [...chosen, record].map(line).join('\n');
    if (tokens(next) <= input.budget) chosen.push(record);
  }
  const fields = {
    arm: 'brain' as const,
    task: input.task,
    asOf: input.asOf,
    budget: input.budget,
    tokens: tokens(chosen.map(line).join('\n')),
    records: chosen.map((record) => record.id),
    text: chosen.map(line).join('\n'),
  };
  return { ...fields, sha256: digest(fields) };
}

/** Arm S: the same static standards for every task, cut at the last whole word within the budget. */
export function staticPacket(input: {
  readonly task: string;
  readonly standards: string;
  readonly asOf: string;
  readonly budget: number;
}): Packet {
  const limit = input.budget * 4;
  let text = input.standards.trimEnd();
  if (text.length > limit) {
    const cut = text.slice(0, limit + 1);
    text = cut.slice(0, Math.max(cut.lastIndexOf(' '), 0)).trimEnd();
  }
  const fields = {
    arm: 'static' as const,
    task: input.task,
    asOf: input.asOf,
    budget: input.budget,
    tokens: tokens(text),
    records: [],
    text,
  };
  return { ...fields, sha256: digest(fields) };
}
