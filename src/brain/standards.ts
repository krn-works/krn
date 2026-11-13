// The standards pack (ADR 0002 records with enforcement): reviewed, dated delivery rules every
// adopted project inherits. Pure parsing, selection and validation; file reads are injected so the
// caller owns the filesystem.
import type { BrainRecord } from './packet.ts';

export const AUDIENCES = ['worker', 'lead', 'adopt'] as const;
/** Strength order: a check refuses a violation, a template makes the right shape the default, a skill is loaded on demand, prose is a line in the brief. */
export const ENFORCEMENTS = ['check', 'template', 'skill', 'prose'] as const;
export const NEEDS = ['tracker', 'ci', 'remote'] as const;

export type Audience = (typeof AUDIENCES)[number];
export type EnforcementKind = (typeof ENFORCEMENTS)[number];
export type Need = (typeof NEEDS)[number];

export type Standard = {
  readonly id: string;
  readonly area: string;
  readonly audience: Audience;
  /** The rule as one statement. */
  readonly text: string;
  /** Why the rule exists, in one sentence. */
  readonly why: string;
  /** Where the rule comes from: `path[#text]`, `#<PR>`, a commit SHA or an https URL. */
  readonly evidence: readonly string[];
  /** What proves the rule: `ref` is `path[#text]` of the check, template, skill or prose line. */
  readonly enforcement: {
    readonly kind: EnforcementKind;
    readonly ref: string;
  };
  /** Empty lists apply everywhere; `stacks` match the detected stack or its family (`node` matches `node/npm`). */
  readonly applies: {
    readonly stacks: readonly string[];
    readonly needs: readonly Need[];
  };
  readonly recorded_at: string;
  readonly valid_from: string;
  readonly valid_to: string | null;
};

export class StandardsDataError extends Error {
  readonly exitCode = 65;
}

const FIELDS = [
  'id',
  'area',
  'audience',
  'text',
  'why',
  'evidence',
  'enforcement',
  'applies',
  'recorded_at',
  'valid_from',
  'valid_to',
] as const;
const ID = /^s-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const AREA = /^[a-z][a-z0-9-]*$/u;

type Json = Record<string, unknown>;

function object(value: unknown, where: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new StandardsDataError(`${where}: expected an object`);
  return value as Json;
}

function exactKeys(value: Json, keys: readonly string[], where: string): void {
  const actual = Object.keys(value).sort().join();
  if (actual !== [...keys].sort().join())
    throw new StandardsDataError(
      `${where}: fields must be exactly ${keys.join(', ')}`,
    );
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new StandardsDataError(`${where}: expected a non-empty string`);
  return value;
}

function date(value: unknown, where: string): string {
  if (
    typeof value !== 'string' ||
    !DATE.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw new StandardsDataError(`${where}: expected a YYYY-MM-DD date`);
  return value;
}

function member<T extends string>(
  value: unknown,
  allowed: readonly T[],
  where: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T))
    throw new StandardsDataError(
      `${where}: expected one of ${allowed.join(', ')}`,
    );
  return value as T;
}

function list<T>(
  value: unknown,
  where: string,
  item: (entry: unknown, at: string) => T,
): T[] {
  if (!Array.isArray(value))
    throw new StandardsDataError(`${where}: expected an array`);
  const items = value.map((entry, index) => item(entry, `${where}[${index}]`));
  if (new Set(items).size !== items.length)
    throw new StandardsDataError(`${where}: duplicate entry`);
  return items;
}

export type Reference =
  | { readonly kind: 'path'; readonly path: string; readonly fragment?: string }
  | { readonly kind: 'pr' | 'commit' | 'url'; readonly value: string };

/** Classifies one evidence or enforcement reference; undefined when it has none of the accepted forms. */
export function reference(entry: string): Reference | undefined {
  if (/^#\d+$/u.test(entry)) return { kind: 'pr', value: entry };
  if (/^[0-9a-f]{7,40}$/u.test(entry)) return { kind: 'commit', value: entry };
  if (/^https:\/\/\S+$/u.test(entry)) return { kind: 'url', value: entry };
  const hash = entry.indexOf('#');
  const path = hash === -1 ? entry : entry.slice(0, hash);
  const fragment = hash === -1 ? undefined : entry.slice(hash + 1);
  if (
    path === '' ||
    path.startsWith('/') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    return undefined;
  if (fragment !== undefined && fragment.trim() === '') return undefined;
  return fragment === undefined
    ? { kind: 'path', path }
    : { kind: 'path', path, fragment };
}

function referenceText(value: unknown, where: string, pathOnly: boolean) {
  const entry = text(value, where);
  const form = reference(entry);
  if (form === undefined || (pathOnly && form.kind !== 'path'))
    throw new StandardsDataError(
      pathOnly
        ? `${where}: expected a repository path, optionally with #text`
        : `${where}: expected a repository path[#text], #<PR>, a commit SHA or an https URL`,
    );
  return entry;
}

function parseStandard(item: unknown, where: string): Standard {
  const r = object(item, where);
  exactKeys(r, FIELDS, where);
  const id = text(r.id, `${where}.id`);
  if (!ID.test(id))
    throw new StandardsDataError(
      `${where}.id: expected s-<kebab-case words>, got ${JSON.stringify(id)}`,
    );
  const area = text(r.area, `${where}.area`);
  if (!AREA.test(area))
    throw new StandardsDataError(`${where}.area: expected a kebab-case word`);
  const evidence = list(r.evidence, `${where}.evidence`, (entry, at) =>
    referenceText(entry, at, false),
  );
  if (evidence.length === 0)
    throw new StandardsDataError(`${where}.evidence: expected at least one`);
  const enforcement = object(r.enforcement, `${where}.enforcement`);
  exactKeys(enforcement, ['kind', 'ref'], `${where}.enforcement`);
  const applies = object(r.applies, `${where}.applies`);
  exactKeys(applies, ['stacks', 'needs'], `${where}.applies`);
  const validFrom = date(r.valid_from, `${where}.valid_from`);
  const validTo =
    r.valid_to === null ? null : date(r.valid_to, `${where}.valid_to`);
  if (validTo !== null && validTo < validFrom)
    throw new StandardsDataError(`${where}: valid_to precedes valid_from`);
  return {
    id,
    area,
    audience: member(r.audience, AUDIENCES, `${where}.audience`),
    text: text(r.text, `${where}.text`),
    why: text(r.why, `${where}.why`),
    evidence,
    enforcement: {
      kind: member(enforcement.kind, ENFORCEMENTS, `${where}.enforcement.kind`),
      ref: referenceText(enforcement.ref, `${where}.enforcement.ref`, true),
    },
    applies: {
      stacks: list(applies.stacks, `${where}.applies.stacks`, (entry, at) => {
        const stack = text(entry, at);
        if (!AREA.test(stack.replace('/', '-')))
          throw new StandardsDataError(`${at}: expected a stack name`);
        return stack;
      }),
      needs: list(applies.needs, `${where}.applies.needs`, (entry, at) =>
        member(entry, NEEDS, at),
      ),
    },
    recorded_at: date(r.recorded_at, `${where}.recorded_at`),
    valid_from: validFrom,
    valid_to: validTo,
  };
}

/** Rejects anything but a list of exact standards with unique ids; the error names the first bad field. */
export function parseStandards(value: unknown): Standard[] {
  if (!Array.isArray(value))
    throw new StandardsDataError('standards: expected a JSON array');
  const seen = new Set<string>();
  return value.map((item, index) => {
    const standard = parseStandard(item, `standards[${index}]`);
    if (seen.has(standard.id))
      throw new StandardsDataError(
        `standards[${index}].id: duplicate id ${standard.id}`,
      );
    seen.add(standard.id);
    return standard;
  });
}

/** What a repository offers that a standard may need. */
export type Repository = {
  /** Detected stack (`python`, `node/npm`, ...), undefined when none was detected. */
  readonly stack?: string;
  readonly needs: ReadonlySet<Need>;
};

export function appliesTo(standard: Standard, repository: Repository): boolean {
  const { stacks, needs } = standard.applies;
  const stack = repository.stack;
  const stackMatches =
    stacks.length === 0 ||
    (stack !== undefined &&
      stacks.some((name) => stack === name || stack.startsWith(`${name}/`)));
  return stackMatches && needs.every((need) => repository.needs.has(need));
}

/** True when the standard is in force on `asOf` (YYYY-MM-DD). */
export function inForce(standard: Standard, asOf: string): boolean {
  return (
    standard.valid_from <= asOf &&
    (standard.valid_to === null || asOf <= standard.valid_to)
  );
}

/** The ADR 0002 record the lane packet reads. */
export function toBrainRecord(standard: Standard): BrainRecord {
  return {
    id: standard.id,
    type: standard.area,
    text: standard.text,
    recorded_at: standard.recorded_at,
    valid_from: standard.valid_from,
    valid_to: standard.valid_to,
    source: standard.evidence.join(', '),
  };
}

export type Problem = { readonly id: string; readonly message: string };

/** Reads a repository-relative file; undefined when it does not exist. */
export type ReadFile = (path: string) => string | undefined;

function resolves(entry: string, read: ReadFile): string | undefined {
  const form = reference(entry);
  if (form === undefined) return `${entry} is not a reference`;
  if (form.kind !== 'path') return undefined;
  const content = read(form.path);
  if (content === undefined) return `${form.path} does not exist`;
  if (form.fragment !== undefined && !content.includes(form.fragment))
    return `${form.path} does not contain ${JSON.stringify(form.fragment)}`;
  return undefined;
}

/** Every standard outside its dates, every enforcement ref and evidence path that does not resolve. */
export function checkStandards(
  standards: readonly Standard[],
  options: { readonly asOf: string; readonly read: ReadFile },
): Problem[] {
  const problems: Problem[] = [];
  for (const standard of standards) {
    const id = standard.id;
    if (!inForce(standard, options.asOf))
      problems.push({
        id,
        message: `outside its dates on ${options.asOf} (valid ${standard.valid_from}..${standard.valid_to ?? 'open'})`,
      });
    const ref = resolves(standard.enforcement.ref, options.read);
    if (ref !== undefined) problems.push({ id, message: `enforcement ${ref}` });
    for (const entry of standard.evidence) {
      const miss = resolves(entry, options.read);
      if (miss !== undefined)
        problems.push({ id, message: `evidence ${miss}` });
    }
  }
  return problems;
}

export type Health = {
  readonly total: number;
  /** Share of standards enforced by a check or a template, 0..1. */
  readonly enforced: number;
  readonly stale: number;
  /** Worker standards that only prose or a skill carries: they spend brief tokens. */
  readonly workerProse: number;
};

export function health(standards: readonly Standard[], asOf: string): Health {
  const total = standards.length;
  const strong = standards.filter(
    (s) => s.enforcement.kind === 'check' || s.enforcement.kind === 'template',
  ).length;
  return {
    total,
    enforced: total === 0 ? 0 : strong / total,
    stale: standards.filter((s) => !inForce(s, asOf)).length,
    workerProse: standards.filter(
      (s) =>
        s.audience === 'worker' &&
        (s.enforcement.kind === 'prose' || s.enforcement.kind === 'skill'),
    ).length,
  };
}
