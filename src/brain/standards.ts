// The standards pack (ADR 0002 records with enforcement): reviewed, dated delivery rules every
// adopted project inherits. Pure parsing, selection and planning; running an enforcement belongs
// to the caller, which owns processes and the filesystem.
import type { BrainRecord } from './packet.ts';
import {
  INHERITED_ORIGIN,
  parseUnified,
  type UnifiedRecord,
} from './record.ts';

export const AUDIENCES = ['worker', 'lead', 'adopt'] as const;
/** `universal` holds in any repository with no KRN; `krn-delivery` needs KRN adopted there. */
export const LAYERS = ['universal', 'krn-delivery'] as const;
/** `command` runs a shell command in the repository, `krn` a krn subcommand there, `advisory` is unenforced. */
export const ENFORCEMENTS = ['command', 'krn', 'advisory'] as const;
/** What a repository offers a standard may need: a KRN tracker, a WordPress site, or a frontend (a WordPress theme or a Vite, Sass, PostCSS or Tailwind build). */
export const NEEDS = ['tracker', 'wordpress', 'frontend'] as const;
/**
 * `floor` failures block the worker Stop, `reflex` failures block unless a waiver with a reason is
 * recorded on the record, `finish` failures are reported only.
 */
export const TIERS = ['floor', 'reflex', 'finish'] as const;

export type Audience = (typeof AUDIENCES)[number];
export type Layer = (typeof LAYERS)[number];
export type EnforcementKind = (typeof ENFORCEMENTS)[number];
export type Need = (typeof NEEDS)[number];
export type Tier = (typeof TIERS)[number];

export type Enforcement =
  /** A shell command run in the repository root; exit 0 means the standard holds. */
  | { readonly kind: 'command'; readonly run: string }
  /** `krn <args>` run in the repository root; valid only for `krn-delivery` records. */
  | { readonly kind: 'krn'; readonly args: readonly string[] }
  /** Explicitly unenforced: counted, never part of a PASS. */
  | { readonly kind: 'advisory' };

/** A standard is a record of the one schema (src/brain/record.ts); `layer`, `waiver` and `harvested` are its standards-pack fields. */
export type Standard = UnifiedRecord;

/** Where a promoted record came from: every proposing repository is kept (SR:66). */
export type Harvested = NonNullable<UnifiedRecord['harvested']>;

/** True for a record `krn adopt` copied from the shipped pack into a project. */
export const isInherited = (standard: Standard): boolean =>
  standard.provenance.origin === INHERITED_ORIGIN;

export class StandardsDataError extends Error {
  readonly exitCode = 65;
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
  for (const { id, harvested, provenance, enforcement } of standards) {
    if (harvested === undefined) continue;
    const evidence = provenance.evidence;
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
  let records: Standard[];
  try {
    records = parseUnified(value);
  } catch (error) {
    throw new StandardsDataError((error as Error).message);
  }
  records.forEach((standard, index) => {
    const where = `records[${index}]`;
    for (const entry of standard.provenance.evidence)
      if (reference(entry) === undefined)
        throw new StandardsDataError(
          `${where}.provenance.evidence: ${JSON.stringify(entry)} is not a repository path[#text], #<PR>, a commit SHA or an https URL`,
        );
    for (const need of standard.applies.needs)
      if (!(NEEDS as readonly string[]).includes(need))
        throw new StandardsDataError(
          `${where}.applies.needs: expected one of ${NEEDS.join(', ')}`,
        );
    if (standard.waiver !== undefined && standard.tier !== 'reflex')
      throw new StandardsDataError(
        `${where}.waiver: only a reflex standard takes a waiver`,
      );
    if (
      standard.enforcement.kind === 'krn' &&
      standard.layer !== 'krn-delivery'
    )
      throw new StandardsDataError(
        `${where}.enforcement.kind: krn enforcement is valid only for layer krn-delivery`,
      );
  });
  return records;
}

/** What a repository offers that a standard may need. */
export type Repository = {
  /** Detected stack (`python`, `node/npm`, ...), undefined when none was detected. */
  readonly stack?: string;
  /** True when KRN is adopted there, so `krn-delivery` standards apply. */
  readonly adopted: boolean;
  readonly needs: ReadonlySet<string>;
};

export function appliesTo(standard: Standard, repository: Repository): boolean {
  if (standard.status === 'retired') return false;
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
    type: standard.area ?? standard.type,
    text: standard.text,
    recorded_at: standard.recorded_at,
    valid_from: standard.valid_from,
    valid_to: standard.valid_to,
    source: standard.provenance.evidence.join(', '),
  };
}

/** One enforcement run: `exit` is null when the process was killed (timeout) or could not start. */
export type Outcome = { readonly exit: number | null; readonly detail: string };

/** Runs one enforcement in the repository root. */
export type Enforce = (
  enforcement: Exclude<Enforcement, { kind: 'advisory' }>,
) => Outcome;

export type Failure = {
  readonly id: string;
  readonly message: string;
  /** Set on a failed enforcement of a standard; structural failures carry none and always block. */
  readonly tier?: Tier;
  /** The failing standard's one-line statement, which is what to make true; absent on structural failures. */
  readonly remedy?: string;
};

/** Enforced and failed standards of one tier. */
export type TierCount = { readonly enforced: number; readonly failed: number };

export type Report = {
  readonly enforced: number;
  readonly advisory: number;
  readonly failures: readonly Failure[];
  readonly tiers: Readonly<Record<Tier, TierCount>>;
  /** The failures that stop work: floor, an unwaived reflex, and any failure without a tier. */
  readonly blocking: readonly Failure[];
};

/** Floor and an unwaived reflex block; a waived reflex and finish only report. */
export function blocks(failure: Failure, standard?: Standard): boolean {
  if (failure.tier === undefined || standard === undefined) return true;
  if (failure.tier === 'floor') return true;
  return failure.tier === 'reflex' && standard.waiver === undefined;
}

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
  const blocking: Failure[] = [];
  const tiers = {
    floor: { enforced: 0, failed: 0 },
    reflex: { enforced: 0, failed: 0 },
    finish: { enforced: 0, failed: 0 },
  };
  let enforced = 0;
  let advisory = 0;
  for (const standard of standards) {
    const { id, enforcement, tier } = standard;
    if (!inForce(standard, options.asOf)) {
      const expired: Failure = {
        id,
        message: `outside its dates on ${options.asOf} (valid ${standard.valid_from}..${standard.valid_to ?? 'open'})`,
      };
      failures.push(expired);
      blocking.push(expired);
      continue;
    }
    if (enforcement.kind === 'advisory') {
      advisory++;
      continue;
    }
    enforced++;
    tiers[tier].enforced++;
    const outcome = options.enforce(enforcement);
    if (outcome.exit !== 0) {
      const failure: Failure = {
        id,
        tier,
        remedy: standard.text,
        message: `exit ${outcome.exit ?? 'none'} from ${describe(enforcement)}${outcome.detail === '' ? '' : `: ${outcome.detail}`}`,
      };
      tiers[tier].failed++;
      failures.push(failure);
      if (blocks(failure, standard)) blocking.push(failure);
    }
  }
  return { enforced, advisory, failures, tiers, blocking };
}

/** The shipped pack: exact standards, none of them marked as inherited. */
export function parsePack(value: unknown): Standard[] {
  const pack = parseStandards(value);
  const marked = pack.find((standard) => isInherited(standard));
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
    inherited: project.filter((standard) => isInherited(standard)),
    own: project.filter((standard) => !isInherited(standard)),
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
    .map(
      (standard): Standard => ({
        ...standard,
        provenance: { ...standard.provenance, origin: INHERITED_ORIGIN },
      }),
    );
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
