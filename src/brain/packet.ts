// Deterministic brain packets (ADR 0002 records, ADR 0014 D32 shadow packets): select the records
// valid at an as-of date that best match a task's text, within a fixed token budget.
import { createHash } from 'node:crypto';

/** ADR 0002 minimal record shape. Dates are ISO `YYYY-MM-DD`. */
export type BrainRecord = {
  readonly id: string;
  readonly type: string;
  readonly text: string;
  readonly recorded_at: string;
  readonly valid_from: string;
  readonly valid_to: string | null;
  readonly source: string;
};

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

export class BrainDataError extends Error {
  readonly exitCode = 65;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const FIELDS = [
  'id',
  'type',
  'text',
  'recorded_at',
  'valid_from',
  'valid_to',
  'source',
] as const;

/** Rejects anything but a list of exact ADR 0002 records with unique ids and ordered dates. */
export function parseRecords(value: unknown): BrainRecord[] {
  if (!Array.isArray(value))
    throw new BrainDataError('records: expected a JSON array');
  const seen = new Set<string>();
  return value.map((item: unknown, index) => {
    const where = `records[${index}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item))
      throw new BrainDataError(`${where}: expected an object`);
    const keys = Object.keys(item).sort();
    if (keys.join() !== [...FIELDS].sort().join())
      throw new BrainDataError(
        `${where}: fields must be exactly ${FIELDS.join(', ')}`,
      );
    const r = item as Record<string, unknown>;
    for (const field of ['id', 'type', 'text', 'source'] as const)
      if (typeof r[field] !== 'string' || r[field] === '')
        throw new BrainDataError(`${where}.${field}: expected text`);
    for (const field of ['recorded_at', 'valid_from'] as const)
      if (typeof r[field] !== 'string' || !DATE.test(r[field]))
        throw new BrainDataError(`${where}.${field}: expected YYYY-MM-DD`);
    if (
      r.valid_to !== null &&
      (typeof r.valid_to !== 'string' || !DATE.test(r.valid_to))
    )
      throw new BrainDataError(
        `${where}.valid_to: expected YYYY-MM-DD or null`,
      );
    const record = r as BrainRecord;
    if (record.valid_to !== null && record.valid_to < record.valid_from)
      throw new BrainDataError(`${where}: valid_to precedes valid_from`);
    if (seen.has(record.id))
      throw new BrainDataError(`${where}: duplicate id ${record.id}`);
    seen.add(record.id);
    return record;
  });
}

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
}): Packet {
  const pool = input.records.filter((record) => known(record, input.asOf));
  const bags = new Map(pool.map((record) => [record.id, terms(record.text)]));
  const frequency = new Map<string, number>();
  for (const bag of bags.values())
    for (const term of bag) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const query = terms(input.query);
  const score = (record: BrainRecord): number => {
    let total = 0;
    for (const term of bags.get(record.id) ?? [])
      if (query.has(term))
        total += Math.log(pool.length / (frequency.get(term) ?? 1)) + 1;
    return total;
  };
  const ranked = pool
    .map((record) => ({ record, score: score(record) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id),
    );
  const chosen: BrainRecord[] = [];
  for (const { record } of ranked) {
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
