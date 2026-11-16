// Delivered evidence proposes records: a CI failure, a failed hidden test, a review finding or an
// operator correction quoted verbatim each become one `trial` record proposal carrying a `subject`.
// A Stop refusal is never a source. The readers take raw rows; the caller owns the filesystem.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Exposure } from './exposures.ts';
import { type EVIDENCE_KINDS, parseUnified } from './record.ts';

/** The four evidence kinds a proposal may rest on; `agent` is not one of them. */
export type ProposalEvidenceKind = Exclude<
  (typeof EVIDENCE_KINDS)[number],
  'agent'
>;

export type EvidenceProposal = {
  readonly evidence_kind: ProposalEvidenceKind;
  /** The conflict key: a record in force with the same subject is superseded by an accepted proposal. */
  readonly subject: string;
  readonly text: string;
  /** Event references: `#PR`, or a path#fragment into the raw event file. */
  readonly evidence: readonly string[];
  readonly recorded_at: string;
  /** `supersede` when a record in force carries the subject, else `add`. */
  readonly action: 'add' | 'supersede';
  readonly supersedes?: string;
};

/** The part of a ledger row a CI failure is read from. */
export type CiRow = {
  readonly number: number;
  readonly prGate: { readonly reruns: number | null };
};

type Draft = Omit<EvidenceProposal, 'action' | 'supersedes' | 'recorded_at'>;

const CI_SUBJECT = 'ci:required-check-rerun';
const OPERATOR_FILE = '.krn/operator/inbox.jsonl';
const EXPOSURES = '.krn/brain/exposures.jsonl';
const MAX_QUOTE = 400;

/** One proposal per distinct subject: its evidence merged, its first text kept. */
function group(drafts: readonly Draft[]): Draft[] {
  const by = new Map<string, Draft>();
  for (const draft of drafts) {
    const have = by.get(draft.subject);
    by.set(
      draft.subject,
      have === undefined
        ? draft
        : {
            ...have,
            evidence: [...new Set([...have.evidence, ...draft.evidence])],
          },
    );
  }
  return [...by.values()];
}

/** A merged PR whose required check needed a rerun is a CI failure the pull request delivered. */
export function ciFailures(rows: readonly CiRow[]): Draft[] {
  const evidence = rows
    .filter((row) => (row.prGate.reruns ?? 0) > 0)
    .map((row) => `#${row.number}`);
  return evidence.length === 0
    ? []
    : [
        {
          evidence_kind: 'ci',
          subject: CI_SUBJECT,
          text: 'Run the full local checks before shipping: a merged pull request needed a rerun of the required CI check.',
          evidence,
        },
      ];
}

/** Close rows only: a failed hidden test, or a failing Check, written back by `krn task close` and the ship. */
export function closeFailures(exposures: readonly Exposure[]): Draft[] {
  return exposures.flatMap((row): Draft[] => {
    if (row.channel !== 'close' || row.task === null) return [];
    const reference =
      row.evidence?.pr == null
        ? `${EXPOSURES}#${row.run}`
        : `#${row.evidence.pr}`;
    const out: Draft[] = [];
    if (row.evidence?.hidden === 'fail')
      out.push({
        evidence_kind: 'hidden-test',
        subject: `hidden-test:${row.task}`,
        text: `The hidden test failed for task ${row.task}: check the behavior its clauses name against the receiver before closing.`,
        evidence: [reference],
      });
    if (row.evidence?.ci?.toLowerCase() === 'failure')
      out.push({
        evidence_kind: 'ci',
        subject: CI_SUBJECT,
        text: 'Run the full local checks before shipping: a merged pull request needed a rerun of the required CI check.',
        evidence: [reference],
      });
    return out;
  });
}

type Finding = { severity?: unknown; title?: unknown; path?: unknown };
type ReviewRecord = {
  attempt?: { pr?: unknown };
  judges?: { findings?: unknown }[];
};

/** Blocking findings of the review judges, one subject per file path. */
export function reviewFindings(records: readonly unknown[]): Draft[] {
  const drafts: Draft[] = [];
  for (const raw of records) {
    const record = raw as ReviewRecord;
    const pr = record?.attempt?.pr;
    if (typeof pr !== 'number') continue;
    for (const judge of record.judges ?? []) {
      if (!Array.isArray(judge.findings)) continue;
      for (const finding of judge.findings as Finding[]) {
        if (
          finding.severity !== 'BLOCKING' ||
          typeof finding.title !== 'string' ||
          typeof finding.path !== 'string'
        )
          continue;
        drafts.push({
          evidence_kind: 'review',
          subject: `review:${finding.path}`,
          text: finding.title.replace(/^\[[^\]]*\]\s*/u, '').trim(),
          evidence: [`#${pr}`],
        });
      }
    }
  }
  return drafts;
}

type InboxRow = { hash?: unknown; text?: unknown; source?: unknown };
type Disposition = { hash?: unknown; kind?: unknown; ref?: unknown };

const HARNESS = /^<[a-z-]+>/u;

/**
 * An operator prompt the lead filed as memory is a correction quoted verbatim: the prompt text, whole,
 * under the subject of the memory it was filed to. Prompts a launcher sent (`source`) are not the operator's.
 */
export function operatorCorrections(
  inbox: readonly InboxRow[],
  dispositions: readonly Disposition[],
): Draft[] {
  const filed = new Map(
    dispositions
      .filter((d) => d.kind === 'memory' && typeof d.hash === 'string')
      .map((d) => [String(d.hash), String(d.ref ?? '')]),
  );
  return inbox.flatMap((row): Draft[] => {
    const ref = typeof row.hash === 'string' ? filed.get(row.hash) : undefined;
    if (
      ref === undefined ||
      ref === '' ||
      row.source !== undefined ||
      typeof row.text !== 'string' ||
      HARNESS.test(row.text.trimStart())
    )
      return [];
    const quote = row.text.replace(/\s+/gu, ' ').trim().slice(0, MAX_QUOTE);
    if (quote === '') return [];
    return [
      {
        evidence_kind: 'operator-verbatim',
        subject: `operator:${ref}`,
        text: quote,
        evidence: [`${OPERATOR_FILE}#${String(row.hash)}`],
      },
    ];
  });
}

/** The proposals of every source; `subjects` maps the subject of each record in force to its id. */
export function evidenceProposals(
  sources: {
    readonly ci: readonly CiRow[];
    readonly exposures: readonly Exposure[];
    readonly reviews: readonly unknown[];
    readonly inbox: readonly InboxRow[];
    readonly dispositions: readonly Disposition[];
  },
  subjects: ReadonlyMap<string, string>,
  recordedAt: string,
): EvidenceProposal[] {
  return group([
    ...ciFailures(sources.ci),
    ...closeFailures(sources.exposures),
    ...reviewFindings(sources.reviews),
    ...operatorCorrections(sources.inbox, sources.dispositions),
  ]).map((draft) => {
    const supersedes = subjects.get(draft.subject);
    return {
      ...draft,
      recorded_at: recordedAt,
      action: supersedes === undefined ? 'add' : 'supersede',
      ...(supersedes === undefined ? {} : { supersedes }),
    };
  });
}

/** The stable id of the trial record a proposal becomes. */
export function trialId(proposal: EvidenceProposal): string {
  const hash = createHash('sha256')
    .update(proposal.subject)
    .digest('hex')
    .slice(0, 8);
  return `trial-${proposal.evidence_kind}-${hash}`;
}

/** Days a trial record waits for its review. */
export const TRIAL_REVIEW_DAYS = 30;

/** The record row for a proposal: advisory, status trial, with its subject, evidence kind and review date. */
export function trialRecord(
  proposal: EvidenceProposal,
): Record<string, unknown> {
  const reviewBy = new Date(
    Date.parse(`${proposal.recorded_at}T00:00:00Z`) +
      TRIAL_REVIEW_DAYS * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  return {
    id: trialId(proposal),
    type: 'pitfall',
    text: proposal.text,
    audience: 'worker',
    enforcement: { kind: 'advisory' },
    provenance: {
      origin: 'krn standards harvest --from-ledger',
      evidence: [...proposal.evidence],
      proposals: [],
    },
    status: 'trial',
    recorded_at: proposal.recorded_at,
    valid_from: proposal.recorded_at,
    valid_to: null,
    supersedes: proposal.supersedes === undefined ? [] : [proposal.supersedes],
    subject: proposal.subject,
    evidence_kind: proposal.evidence_kind,
    review_by: reviewBy,
  };
}

/** The dry-run report: one line per proposal with its evidence kind, a count per kind last. */
export function renderEvidenceProposals(
  proposals: readonly EvidenceProposal[],
): string[] {
  const counts = new Map<string, number>();
  for (const p of proposals)
    counts.set(p.evidence_kind, (counts.get(p.evidence_kind) ?? 0) + 1);
  const kinds = [...counts].map(([kind, n]) => `${kind} ${n}`).join(', ');
  return [
    ...proposals.map(
      (p) =>
        `proposal evidence_kind=${p.evidence_kind} subject=${p.subject} action=${p.action}${p.supersedes === undefined ? '' : ` supersedes=${p.supersedes}`}: ${p.text} [${p.evidence.join(', ')}]`,
    ),
    `proposals: ${proposals.length}${kinds === '' ? '' : ` (${kinds})`}`,
  ];
}

const RECORD_FILES = ['standards/records.json', '.agents/records.json'];

/** Subject to id of every record in force, over the pack and the conventions file of `root`. */
export function subjectsInForce(root: string): Map<string, string> {
  const subjects = new Map<string, string>();
  for (const file of RECORD_FILES) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    for (const record of parseUnified(JSON.parse(readFileSync(path, 'utf8'))))
      if (
        record.subject !== undefined &&
        record.valid_to === null &&
        record.status !== 'retired'
      )
        subjects.set(record.subject, record.id);
  }
  return subjects;
}

/** Appends the trial record of each proposal to the conventions file; a record already there is kept. */
export function writeTrialRecords(
  root: string,
  proposals: readonly EvidenceProposal[],
): number {
  const path = join(root, '.agents/records.json');
  const existing = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>[])
    : [];
  const have = new Set(existing.map((record) => record.id));
  const added = proposals.filter((p) => !have.has(trialId(p)));
  const next = [...existing, ...added.map(trialRecord)];
  parseUnified(next);
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return added.length;
}
