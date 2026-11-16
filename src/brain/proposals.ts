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

/** Days a committed proposal may wait for its disposition before the repository check fails. */
export const PROPOSAL_REVIEW_DAYS = 14;

/**
 * Proposals neither disposed by an enforced record nor inside the review window: a retro commits
 * its proposal with the slice, and the lead has PROPOSAL_REVIEW_DAYS to turn it into a record.
 */
export function overdueProposals(
  proposals: readonly Proposal[],
  enforcedTexts: ReadonlySet<string>,
  today: string,
  reviewDays = PROPOSAL_REVIEW_DAYS,
): Proposal[] {
  const now = Date.parse(`${today}T00:00:00Z`);
  return proposals.filter(
    (proposal) =>
      !enforcedTexts.has(normalizeText(proposal.text)) &&
      now - Date.parse(`${proposal.recorded_at}T00:00:00Z`) >
        reviewDays * 86_400_000,
  );
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

/** The instruction files `harvest --repos` reads at the top of each named repository. */
export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/u;
const MIN_BULLET_WORDS = 3;

/**
 * The grouping key of an instruction bullet: markdown, case, punctuation and spacing do not make
 * a different rule. Empty when the bullet is too short to be a rule.
 */
export function normalizeBullet(text: string): string {
  const key = text
    .normalize('NFKC')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return key.split(' ').length < MIN_BULLET_WORDS ? '' : key;
}

/** The bullets of one markdown document as written, continuation lines joined; code fences are skipped. */
export function instructionBullets(markdown: string): string[] {
  const bullets: string[] = [];
  let open: { indent: number; text: string } | undefined;
  let fenced = false;
  const close = () => {
    if (open !== undefined) bullets.push(open.text.trim());
    open = undefined;
  };
  for (const line of markdown.split(/\r?\n/u)) {
    if (/^\s*(```|~~~)/u.test(line)) {
      close();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = BULLET.exec(line);
    if (match !== null) {
      close();
      open = { indent: (match[1] ?? '').length, text: match[2] ?? '' };
    } else if (open !== undefined && line.trim() !== '') {
      const indent = line.length - line.trimStart().length;
      if (indent > open.indent) open.text += ` ${line.trim()}`;
      else close();
    } else close();
  }
  close();
  return bullets;
}

/** One instruction file of one repository, as data. */
export type InstructionSource = {
  readonly repository: string;
  readonly origin: string;
  readonly file: string;
  readonly text: string;
};

export type BulletCandidate = {
  /** The first bullet of the group, as written. */
  readonly text: string;
  readonly repositories: number;
  /** Each place the bullet appears: `origin/file`. */
  readonly sources: readonly string[];
};

/** Bullets recurring in at least `minRepositories` distinct repositories; most repositories first, then by text. */
export function harvestInstructionBullets(
  sources: readonly InstructionSource[],
  minRepositories = 2,
): BulletCandidate[] {
  const groups = new Map<
    string,
    { text: string; repositories: Set<string>; sources: string[] }
  >();
  for (const source of sources) {
    for (const bullet of instructionBullets(source.text)) {
      const key = normalizeBullet(bullet);
      if (key === '') continue;
      const group = groups.get(key) ?? {
        text: bullet,
        repositories: new Set<string>(),
        sources: [],
      };
      group.repositories.add(source.repository);
      const place = `${source.origin}/${source.file}`;
      if (!group.sources.includes(place)) group.sources.push(place);
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .filter((group) => group.repositories.size >= minRepositories)
    .map((group) => ({
      text: group.text,
      repositories: group.repositories.size,
      sources: group.sources,
    }))
    .sort(
      (a, b) => b.repositories - a.repositories || a.text.localeCompare(b.text),
    );
}

/** The report: one `candidate` line per recurring bullet with its sources, a summary line last. Nothing is recorded. */
export function renderBulletHarvest(
  candidates: readonly BulletCandidate[],
  repositories: number,
): string[] {
  return [
    ...candidates.flatMap((c) => [
      `candidate in ${c.repositories} repositories: ${c.text}`,
      `  sources: ${c.sources.join(', ')}`,
    ]),
    `harvest: ${candidates.length} ${candidates.length === 1 ? 'candidate' : 'candidates'} from instruction files of ${repositories} ${repositories === 1 ? 'repository' : 'repositories'}; review each into a record, none was written`,
  ];
}

/** The part of a ledger row a lesson is drawn from. */
export type LedgerRow = {
  readonly number: number;
  readonly prGate: { readonly reruns: number | null };
  readonly outcome: { readonly status: string };
};

const RED_CI_LESSON =
  'Run the full local checks before shipping: a merged pull request needed a rerun of the required CI check.';
const REWORK_LESSON =
  'Verify the change against its receiver before shipping: a merged pull request was later changed or reverted.';

/** One proposal per rework or CI-failed merged PR, with `#PR` evidence; a PR with both gives both. */
export function ledgerProposals(
  origin: string,
  repository: string,
  rows: readonly LedgerRow[],
  recordedAt: string,
): Sourced[] {
  const lessons = (row: LedgerRow): string[] => [
    ...((row.prGate.reruns ?? 0) > 0 ? [RED_CI_LESSON] : []),
    ...(row.outcome.status === 'changed' || row.outcome.status === 'reverted'
      ? [REWORK_LESSON]
      : []),
  ];
  return rows.flatMap((row) =>
    lessons(row).map((text) => ({
      origin,
      repository,
      file: `ledger#${row.number}`,
      proposal: {
        text,
        kind: 'check' as const,
        evidence: [`#${row.number}`],
        recorded_at: recordedAt,
      },
    })),
  );
}

/** Where a repository keeps its research candidates (`krn.candidate/v1` files), tracked, one per file. */
export const RESEARCH_DIR = '.agents/research-candidates';

/** Days a research candidate may wait for a merged PR or a retire verdict before it is listed as stale. */
export const RESEARCH_STALE_DAYS = 7;

export type ResearchCandidate = {
  readonly schema: 'krn.candidate/v1';
  readonly id: string;
  readonly source: Readonly<Record<string, string>>;
  readonly pillar: string;
  readonly claim: string;
  /** The failing recall-eval case, hidden test or review finding that pulled this research in. */
  readonly motivated_by: string;
  /** An existing OSS tool, library or skill to adopt, with its https URL. */
  readonly reuse?: string;
  /** Why nothing existing fits; present exactly when `reuse` is absent. */
  readonly build_because?: string;
  readonly recorded_at: string;
  /** `#<PR>` of the merged change that adopted the candidate. */
  readonly merged_pr?: string;
  /** Why the candidate was dropped. */
  readonly retire?: string;
};

const CANDIDATE_REQUIRED = [
  'schema',
  'id',
  'source',
  'pillar',
  'claim',
  'motivated_by',
  'recorded_at',
];
const CANDIDATE_OPTIONAL = [
  'reuse',
  'build_because',
  'merged_pr',
  'retire',
  'record_draft',
  'experiment',
  'expires',
];

function field(
  where: string,
  object: Record<string, unknown>,
  key: string,
): string {
  const value = object[key];
  if (typeof value !== 'string' || value.trim() === '')
    fail(`${where}.${key}`, 'expected a non-empty string');
  return value.trim();
}

/** Refuses a candidate that names no reuse and no reason to build, or no motivating failure. */
export function parseResearchCandidate(
  value: unknown,
  where = 'candidate',
): ResearchCandidate {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(where, 'expected an object');
  const c = value as Record<string, unknown>;
  for (const key of CANDIDATE_REQUIRED)
    if (!(key in c)) fail(`${where}.${key}`, 'is required');
  for (const key of Object.keys(c))
    if (!CANDIDATE_REQUIRED.includes(key) && !CANDIDATE_OPTIONAL.includes(key))
      fail(`${where}.${key}`, 'is not a candidate field');
  if (c.schema !== 'krn.candidate/v1')
    fail(`${where}.schema`, 'expected "krn.candidate/v1"');
  const source = c.source;
  if (typeof source !== 'object' || source === null || Array.isArray(source))
    fail(`${where}.source`, 'expected an object');
  const s = source as Record<string, unknown>;
  if (typeof s.url !== 'string' && typeof s.arxiv_id !== 'string')
    fail(`${where}.source`, 'expected a url or an arxiv_id');
  const sourceText = Object.fromEntries(
    ['url', 'arxiv_id', 'quote', 'sha256'].flatMap((key) =>
      typeof s[key] === 'string' ? [[key, s[key] as string]] : [],
    ),
  );
  const reuse = c.reuse === undefined ? undefined : field(where, c, 'reuse');
  const because =
    c.build_because === undefined
      ? undefined
      : field(where, c, 'build_because');
  if ((reuse === undefined) === (because === undefined))
    fail(
      where,
      'name exactly one of reuse (an existing tool with its https URL) or build_because',
    );
  if (reuse !== undefined && !/https:\/\/\S+/u.test(reuse))
    fail(`${where}.reuse`, 'expected the https URL of the existing tool');
  const recordedAt = field(where, c, 'recorded_at');
  if (
    !DATE.test(recordedAt) ||
    Number.isNaN(Date.parse(`${recordedAt}T00:00:00Z`))
  )
    fail(`${where}.recorded_at`, 'expected a YYYY-MM-DD date');
  if (c.merged_pr !== undefined && !/^#\d+$/u.test(String(c.merged_pr)))
    fail(`${where}.merged_pr`, 'expected #<PR>');
  return {
    schema: 'krn.candidate/v1',
    id: field(where, c, 'id'),
    source: sourceText,
    pillar: field(where, c, 'pillar'),
    claim: field(where, c, 'claim'),
    motivated_by: field(where, c, 'motivated_by'),
    ...(reuse === undefined ? {} : { reuse }),
    ...(because === undefined ? {} : { build_because: because }),
    recorded_at: recordedAt,
    ...(c.merged_pr === undefined ? {} : { merged_pr: String(c.merged_pr) }),
    ...(c.retire === undefined ? {} : { retire: field(where, c, 'retire') }),
  };
}

/** Candidates older than `days` with neither a merged PR nor a retire verdict. */
export function staleResearch(
  candidates: readonly ResearchCandidate[],
  today: string,
  days = RESEARCH_STALE_DAYS,
): ResearchCandidate[] {
  const now = Date.parse(`${today}T00:00:00Z`);
  return candidates.filter(
    (c) =>
      c.merged_pr === undefined &&
      c.retire === undefined &&
      now - Date.parse(`${c.recorded_at}T00:00:00Z`) > days * 86_400_000,
  );
}
