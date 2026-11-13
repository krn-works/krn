// Standards proposals: a lesson an adopted repository's retro writes as one tracked file under
// .agents/standards-proposals/, and the harvest that groups them across repositories into
// candidates for the KRN pack. Pure parsing, naming and grouping; the caller owns the filesystem.
import { createHash } from 'node:crypto';
import { recursEnough, reference, StandardsDataError } from './standards.ts';

/** Where a repository keeps its proposals, relative to its root; tracked, one file per proposal. */
export const PROPOSALS_DIR = '.agents/standards-proposals';

/** How the lesson would be enforced once promoted. */
export const PROPOSAL_KINDS = ['check', 'template', 'skill', 'prose'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export type Proposal = {
  /** The lesson as one statement. */
  readonly text: string;
  readonly kind: ProposalKind;
  /** `#<PR>`, a commit SHA, a repository path[#text] or an https URL; at least one. */
  readonly evidence: readonly string[];
  readonly recorded_at: string;
};

const FIELDS = ['text', 'kind', 'evidence', 'recorded_at'];
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

function fail(where: string, message: string): never {
  throw new StandardsDataError(`${where}: ${message}`);
}

/** Refuses anything but the exact proposal shape; the error names the first bad field. */
export function parseProposal(value: unknown, where = 'proposal'): Proposal {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(where, 'expected an object');
  const p = value as Record<string, unknown>;
  if (Object.keys(p).sort().join() !== [...FIELDS].sort().join())
    fail(where, `fields must be exactly ${FIELDS.join(', ')}`);
  if (typeof p.text !== 'string' || p.text.trim() === '')
    fail(`${where}.text`, 'expected a non-empty string');
  if (
    typeof p.kind !== 'string' ||
    !PROPOSAL_KINDS.includes(p.kind as ProposalKind)
  )
    fail(`${where}.kind`, `expected one of ${PROPOSAL_KINDS.join(', ')}`);
  if (!Array.isArray(p.evidence) || p.evidence.length === 0)
    fail(`${where}.evidence`, 'expected a non-empty array');
  const evidence = p.evidence.map((entry, index) => {
    if (typeof entry !== 'string' || reference(entry) === undefined)
      fail(
        `${where}.evidence[${index}]`,
        'expected a repository path[#text], #<PR>, a commit SHA or an https URL',
      );
    return entry;
  });
  if (
    typeof p.recorded_at !== 'string' ||
    !DATE.test(p.recorded_at) ||
    Number.isNaN(Date.parse(`${p.recorded_at}T00:00:00Z`))
  )
    fail(`${where}.recorded_at`, 'expected a YYYY-MM-DD date');
  return {
    text: p.text.trim(),
    kind: p.kind as ProposalKind,
    evidence,
    recorded_at: p.recorded_at,
  };
}

/** The grouping key: case, spacing and a closing full stop do not make a different lesson. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.!]+$/u, '');
}

/** The file name of a proposal: a readable slug of its text plus a hash of the normalized text. */
export function proposalFileName(text: string): string {
  const key = normalizeText(text);
  const slug = key
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .split('-')
    .slice(0, 6)
    .join('-')
    .slice(0, 48)
    .replace(/-+$/u, '');
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 8);
  return `${slug === '' ? 'proposal' : slug}-${hash}.json`;
}

/** The proposal file text: stable key order, trailing newline. */
export function formatProposal(proposal: Proposal): string {
  return `${JSON.stringify(proposal, null, 2)}\n`;
}

/** One proposal read from one repository. */
export type Sourced = {
  /** The repository's name, kept as the origin of a promoted record. */
  readonly origin: string;
  /** The repository's resolved root: two roots never count as one repository. */
  readonly repository: string;
  /** The proposal file, relative to the repository root. */
  readonly file: string;
  readonly proposal: Proposal;
};

export type Candidate = {
  /** The text of the first proposal in the group. */
  readonly text: string;
  readonly occurrences: number;
  /** Distinct origins, in harvest order. */
  readonly origins: readonly string[];
  readonly repositories: number;
  readonly kinds: readonly ProposalKind[];
  /** Each evidence entry prefixed with its origin (`origin:#12`). */
  readonly evidence: readonly string[];
  /** True when the lesson recurs enough for the promotion rule of `krn standards check`. */
  readonly promotable: boolean;
};

/** Groups proposals by normalized text; most occurrences first, then by text. */
export function harvestCandidates(sourced: readonly Sourced[]): Candidate[] {
  const groups = new Map<string, Sourced[]>();
  for (const item of sourced) {
    const key = normalizeText(item.proposal.text);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const candidates = [...groups.values()].map((items): Candidate => {
    const unique = <T>(values: T[]) => [...new Set(values)];
    const origins = unique(items.map((item) => item.origin));
    const repositories = unique(items.map((item) => item.repository)).length;
    const external = items.flatMap((item) => item.proposal.evidence);
    return {
      text: items[0]?.proposal.text ?? '',
      occurrences: items.length,
      origins,
      repositories,
      kinds: unique(items.map((item) => item.proposal.kind)),
      evidence: unique(
        items.flatMap((item) =>
          item.proposal.evidence.map((entry) => `${item.origin}:${entry}`),
        ),
      ),
      promotable: recursEnough(repositories, items.length, external),
    };
  });
  return candidates.sort(
    (a, b) => b.occurrences - a.occurrences || a.text.localeCompare(b.text),
  );
}

/** The harvest report: one `candidate` line per group with its details, a summary line last. */
export function renderHarvest(
  candidates: readonly Candidate[],
  repositories: number,
): string[] {
  const proposals = candidates.reduce((sum, c) => sum + c.occurrences, 0);
  const promotable = candidates.filter((c) => c.promotable).length;
  return [
    ...candidates.flatMap((c) => [
      `candidate count ${c.occurrences} in ${c.repositories} ${c.repositories === 1 ? 'repository' : 'repositories'}${c.promotable ? ' (promotable)' : ''}: ${c.text}`,
      `  kinds: ${c.kinds.join(', ')}; origins: ${c.origins.join(', ')}; evidence: ${c.evidence.join(', ')}`,
    ]),
    `harvest: ${candidates.length} ${candidates.length === 1 ? 'candidate' : 'candidates'} from ${proposals} ${proposals === 1 ? 'proposal' : 'proposals'} in ${repositories} ${repositories === 1 ? 'repository' : 'repositories'}, ${promotable} promotable`,
  ];
}
