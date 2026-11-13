// The standards pack (ADR 0002 records with enforcement): reviewed, dated delivery rules every
// adopted project inherits. Pure parsing, selection and planning; running an enforcement belongs
// to the caller, which owns processes and the filesystem.
import type { BrainRecord } from './packet.ts';

export const AUDIENCES = ['worker', 'lead', 'adopt'] as const;
/** `universal` holds in any repository with no KRN; `krn-delivery` needs KRN adopted there. */
export const LAYERS = ['universal', 'krn-delivery'] as const;
/** `command` runs a shell command in the repository, `krn` a krn subcommand there, `advisory` is unenforced. */
export const ENFORCEMENTS = ['command', 'krn', 'advisory'] as const;
export const NEEDS = ['tracker'] as const;

export type Audience = (typeof AUDIENCES)[number];
export type Layer = (typeof LAYERS)[number];
export type EnforcementKind = (typeof ENFORCEMENTS)[number];
export type Need = (typeof NEEDS)[number];

export type Enforcement =
  /** A shell command run in the repository root; exit 0 means the standard holds. */
  | { readonly kind: 'command'; readonly run: string }
  /** `krn <args>` run in the repository root; valid only for `krn-delivery` records. */
  | { readonly kind: 'krn'; readonly args: readonly string[] }
  /** Explicitly unenforced: counted, never part of a PASS. */
  | { readonly kind: 'advisory' };

export type Standard = {
  readonly id: string;
  readonly area: string;
  readonly layer: Layer;
  readonly audience: Audience;
  /** The rule as one statement. */
  readonly text: string;
  /** Why the rule exists, in one sentence. */
  readonly why: string;
  /** Provenance only, never resolved in the checked repository: `path[#text]`, `#<PR>`, a commit SHA or an https URL. */
  readonly evidence: readonly string[];
  readonly enforcement: Enforcement;
  /** Empty lists apply everywhere; `stacks` match the detected stack or its family (`node` matches `node/npm`). */
  readonly applies: {
    readonly stacks: readonly string[];
    readonly needs: readonly Need[];
  };
  readonly recorded_at: string;
  readonly valid_from: string;
  readonly valid_to: string | null;
  /** Set only on a pack record copied into a project by `krn adopt`; a project's own record has none. */
  readonly origin?: typeof INHERITED;
  /** Set on a record promoted from harvested proposals: the repositories that proposed it and how often. */
  readonly harvested?: Harvested;
};

/** Where a promoted record came from: every proposing repository is kept (SR:66). */
export type Harvested = {
  readonly origins: readonly string[];
  readonly occurrences: number;
};

/** The origin of a record `krn adopt` copied from the shipped pack into a project. */
export const INHERITED = 'krn';

export class StandardsDataError extends Error {
  readonly exitCode = 65;
}

const FIELDS = [
  'id',
  'area',
  'layer',
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
/** Fields a record may carry beyond FIELDS. */
const OPTIONAL = ['origin', 'harvested'] as const;
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

/** Classifies one evidence reference; undefined when it has none of the accepted forms. */
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

function evidenceText(value: unknown, where: string): string {
  const entry = text(value, where);
  if (reference(entry) === undefined)
    throw new StandardsDataError(
      `${where}: expected a repository path[#text], #<PR>, a commit SHA or an https URL`,
    );
  return entry;
}

function parseEnforcement(
  value: unknown,
  layer: Layer,
  where: string,
): Enforcement {
  const e = object(value, where);
  const kind = member(e.kind, ENFORCEMENTS, `${where}.kind`);
  if (kind === 'advisory') {
    exactKeys(e, ['kind'], where);
    return { kind };
  }
  if (kind === 'command') {
    exactKeys(e, ['kind', 'run'], where);
    return { kind, run: text(e.run, `${where}.run`) };
  }
  exactKeys(e, ['kind', 'args'], where);
  if (layer !== 'krn-delivery')
    throw new StandardsDataError(
      `${where}.kind: krn enforcement is valid only for layer krn-delivery`,
    );
  const args = list(e.args, `${where}.args`, (entry, at) => text(entry, at));
  if (args.length === 0)
    throw new StandardsDataError(`${where}.args: expected a krn subcommand`);
  return { kind, args };
}

function parseStandard(item: unknown, where: string): Standard {
  const r = object(item, where);
  exactKeys(r, [...FIELDS, ...OPTIONAL.filter((field) => field in r)], where);
  if ('origin' in r && r.origin !== INHERITED)
    throw new StandardsDataError(
      `${where}.origin: expected ${JSON.stringify(INHERITED)} (a record krn adopt inherited) or no origin`,
    );
  const id = text(r.id, `${where}.id`);
  if (!ID.test(id))
    throw new StandardsDataError(
      `${where}.id: expected s-<kebab-case words>, got ${JSON.stringify(id)}`,
    );
  const area = text(r.area, `${where}.area`);
  if (!AREA.test(area))
    throw new StandardsDataError(`${where}.area: expected a kebab-case word`);
  const layer = member(r.layer, LAYERS, `${where}.layer`);
  const evidence = list(r.evidence, `${where}.evidence`, evidenceText);
  if (evidence.length === 0)
    throw new StandardsDataError(`${where}.evidence: expected at least one`);
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
    layer,
    audience: member(r.audience, AUDIENCES, `${where}.audience`),
    text: text(r.text, `${where}.text`),
    why: text(r.why, `${where}.why`),
    evidence,
    enforcement: parseEnforcement(r.enforcement, layer, `${where}.enforcement`),
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
    ...('origin' in r ? ({ origin: INHERITED } as const) : {}),
    ...('harvested' in r
      ? { harvested: parseHarvested(r.harvested, `${where}.harvested`) }
      : {}),
  };
}

function parseHarvested(value: unknown, where: string): Harvested {
  const h = object(value, where);
  exactKeys(h, ['origins', 'occurrences'], where);
  const origins = list(h.origins, `${where}.origins`, (entry, at) =>
    text(entry, at),
  );
  if (origins.length === 0)
    throw new StandardsDataError(`${where}.origins: expected at least one`);
  const occurrences = h.occurrences;
  if (
    typeof occurrences !== 'number' ||
    !Number.isInteger(occurrences) ||
    occurrences < origins.length
  )
    throw new StandardsDataError(
      `${where}.occurrences: expected an integer of at least ${origins.length} (one per origin)`,
    );
  return { origins, occurrences };
}

/** A harvested lesson is promotable when this many repositories proposed it... */
export const PROMOTE_REPOSITORIES = 2;
/** ...or it was proposed this many times in total. */
export const PROMOTE_OCCURRENCES = 3;

/** True when a lesson recurs enough to promote: ≥2 repositories, ≥3 proposals, or an external https source. */
export function recursEnough(
  repositories: number,
  occurrences: number,
  evidence: readonly string[],
): boolean {
  return (
    repositories >= PROMOTE_REPOSITORIES ||
    occurrences >= PROMOTE_OCCURRENCES ||
    evidence.some((entry) => reference(entry)?.kind === 'url')
  );
}

/**
 * The promotion rule for pack records promoted from harvested proposals: they recur
 * (`recursEnough`) and carry an enforcement, since a lesson that no check proves is not
 * promoted (no compliance eval exists for prose yet). Evidence is mandatory for every record.
 */
export function promotionFailures(standards: readonly Standard[]): Failure[] {
  const failures: Failure[] = [];
  for (const { id, harvested, evidence, enforcement } of standards) {
    if (harvested === undefined) continue;
    if (
      !recursEnough(harvested.origins.length, harvested.occurrences, evidence)
    )
      failures.push({
        id,
        message: `promotion rule: harvested from origins ${harvested.origins.join(', ')} in ${harvested.occurrences} proposals; needs ${PROMOTE_REPOSITORIES} repositories, ${PROMOTE_OCCURRENCES} proposals or an https evidence source`,
      });
    if (enforcement.kind === 'advisory')
      failures.push({
        id,
        message:
          'promotion rule: a harvested standard needs a command or krn enforcement, not advisory',
      });
  }
  return failures;
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
  /** True when KRN is adopted there, so `krn-delivery` standards apply. */
  readonly adopted: boolean;
  readonly needs: ReadonlySet<Need>;
};

export function appliesTo(standard: Standard, repository: Repository): boolean {
  if (standard.layer === 'krn-delivery' && !repository.adopted) return false;
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

/** One enforcement run: `exit` is null when the process was killed (timeout) or could not start. */
export type Outcome = { readonly exit: number | null; readonly detail: string };

/** Runs one enforcement in the repository root. */
export type Enforce = (
  enforcement: Exclude<Enforcement, { kind: 'advisory' }>,
) => Outcome;

export type Failure = { readonly id: string; readonly message: string };

export type Report = {
  readonly enforced: number;
  readonly advisory: number;
  readonly failures: readonly Failure[];
};

/** How an enforcement reads in a failure line. */
export function describe(enforcement: Enforcement): string {
  if (enforcement.kind === 'command') return enforcement.run;
  if (enforcement.kind === 'krn') return `krn ${enforcement.args.join(' ')}`;
  return 'advisory';
}

/**
 * Runs every enforced standard, counts advisory ones. A standard outside its dates is a failure
 * and is not run: an expired standard needs review, not silent enforcement.
 */
export function checkStandards(
  standards: readonly Standard[],
  options: { readonly asOf: string; readonly enforce: Enforce },
): Report {
  const failures: Failure[] = [];
  let enforced = 0;
  let advisory = 0;
  for (const standard of standards) {
    const { id, enforcement } = standard;
    if (!inForce(standard, options.asOf)) {
      failures.push({
        id,
        message: `outside its dates on ${options.asOf} (valid ${standard.valid_from}..${standard.valid_to ?? 'open'})`,
      });
      continue;
    }
    if (enforcement.kind === 'advisory') {
      advisory++;
      continue;
    }
    enforced++;
    const outcome = options.enforce(enforcement);
    if (outcome.exit !== 0)
      failures.push({
        id,
        message: `exit ${outcome.exit ?? 'none'} from ${describe(enforcement)}${outcome.detail === '' ? '' : `: ${outcome.detail}`}`,
      });
  }
  return { enforced, advisory, failures };
}

/** The shipped pack: exact standards, none of them marked as inherited. */
export function parsePack(value: unknown): Standard[] {
  const pack = parseStandards(value);
  const marked = pack.find((standard) => standard.origin !== undefined);
  if (marked !== undefined)
    throw new StandardsDataError(
      `standards: pack record ${marked.id} carries an origin; only a project copy does`,
    );
  return pack;
}

/** A project file split into the pack copies `krn adopt` wrote and the project's own records. */
export function splitProject(project: readonly Standard[]): {
  readonly inherited: Standard[];
  readonly own: Standard[];
} {
  return {
    inherited: project.filter((standard) => standard.origin === INHERITED),
    own: project.filter((standard) => standard.origin === undefined),
  };
}

/** Refuses a project's own record that reuses a pack id: it would silently replace an inherited standard. */
export function assertNoClash(
  pack: readonly Standard[],
  own: readonly Standard[],
  file: string,
): void {
  const packIds = new Set(pack.map((standard) => standard.id));
  const clash = own.filter((standard) => packIds.has(standard.id));
  if (clash.length > 0)
    throw new StandardsDataError(
      `${file} redefines pack standard ${clash.map((standard) => standard.id).join(', ')}; give a project standard its own id`,
    );
}

/**
 * What `krn adopt` writes to a project: the universal pack records that apply to it, marked
 * inherited and refreshed from the pack, then the project's own records unchanged. A
 * `krn-delivery` record is never copied: `krn standards check` takes it from the pack.
 */
export function seedStandards(
  pack: readonly Standard[],
  existing: readonly Standard[],
  repository: Repository,
  file: string,
): Standard[] {
  const { own } = splitProject(existing);
  assertNoClash(pack, own, file);
  const inherited = pack
    .filter(
      (standard) =>
        standard.layer === 'universal' && appliesTo(standard, repository),
    )
    .map((standard): Standard => ({ ...standard, origin: INHERITED }));
  return [...inherited, ...own];
}

/** The project file text: one record per entry, stable key order, trailing newline. */
export function formatStandards(standards: readonly Standard[]): string {
  return `${JSON.stringify(standards, null, 2)}\n`;
}

export const BLOCK_START = '<!-- krn-standards:start -->';
export const BLOCK_END = '<!-- krn-standards:end -->';

/** How an enforcement reads in the instruction file. */
function enforcedBy(enforcement: Enforcement): string {
  if (enforcement.kind === 'advisory') return 'advisory, not checked';
  return `checked by \`krn standards check\`: \`${describe(enforcement)}\``;
}

/** The AGENTS.md block rendered from the project's standards: statement and enforcement of each. */
export function renderStandardsBlock(standards: readonly Standard[]): string {
  return [
    BLOCK_START,
    '<!-- Generated by `krn adopt` from .agents/standards.json; rerun it to refresh this block. -->',
    '# Standards',
    '',
    ...standards.map(
      (standard) =>
        `- **${standard.id}** ${standard.text} _(${enforcedBy(standard.enforcement)})_`,
    ),
    BLOCK_END,
    '',
  ].join('\n');
}

/** `current` with the standards block replaced in place, else appended once. */
export function upsertStandardsBlock(current: string, block: string): string {
  const start = current.indexOf(BLOCK_START);
  const end = current.indexOf(BLOCK_END);
  if (start >= 0 && end > start)
    return `${current.slice(0, start)}${block}${current.slice(end + BLOCK_END.length).replace(/^\n/u, '')}`;
  return current === '' ? block : `${current.replace(/\n*$/u, '\n')}\n${block}`;
}

/** The worker brief section: the in-force worker standards of a project, inherited ones marked. */
export function briefStandards(
  standards: readonly Standard[],
  asOf: string,
  file: string,
): string {
  const lines = standards
    .filter(
      (standard) => standard.audience === 'worker' && inForce(standard, asOf),
    )
    .map(
      (standard) =>
        `- [${standard.id}]${standard.origin === INHERITED ? ' (inherited from krn)' : ''} ${standard.text}`,
    );
  if (lines.length === 0) return '';
  return `Repository standards (${file}; \`krn standards check\` enforces the checked ones):\n${lines.join('\n')}`;
}
