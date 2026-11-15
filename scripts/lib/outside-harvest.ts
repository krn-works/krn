// What an outside row leaves behind for the brain: the records its Stop hook refused become
// proposals, and a proposal seen in two or more row repositories is promoted onto the enforced
// pack record it names. Pure: the caller reads the checkouts and writes the files.
import type { Exposure } from '../../src/brain/exposures.ts';
import {
  type Candidate,
  normalizeText,
  type Sourced,
} from '../../src/brain/proposals.ts';
import type { UnifiedRecord } from '../../src/brain/record.ts';

/** The records a row's Stop hook refused, once each, in log order. */
export function refusedRecords(exposures: readonly Exposure[]): string[] {
  const ids = exposures
    .filter((exposure) => exposure.channel === 'stop')
    .flatMap((exposure) =>
      Object.entries(exposure.outcome).flatMap(([id, outcome]) =>
        outcome === 'violated' ? [id] : [],
      ),
    );
  return [...new Set(ids)];
}

/** The `krn standards propose` arguments for each refused record the pack knows; others are skipped. */
export function proposeArgs(
  refused: readonly string[],
  pack: readonly Pick<UnifiedRecord, 'id' | 'text'>[],
  stack: string,
): string[][] {
  return refused.flatMap((id) => {
    const record = pack.find((entry) => entry.id === id);
    return record === undefined
      ? []
      : [
          [
            'standards',
            'propose',
            '--text',
            record.text,
            '--kind',
            'check',
            '--evidence',
            `outside:${stack}:stop:${id}`,
          ],
        ];
  });
}

/**
 * The pack with `harvested` set on every enforced record that a promotable candidate names by its
 * text. A candidate no pack record states, or one whose record is advisory, is left out: it has no
 * enforcement to promote.
 */
export function promoteCandidates(
  pack: readonly UnifiedRecord[],
  candidates: readonly Candidate[],
): { pack: UnifiedRecord[]; promoted: string[] } {
  const promoted: string[] = [];
  const next = pack.map((record) => {
    const candidate = candidates.find(
      (entry) =>
        entry.promotable &&
        normalizeText(entry.text) === normalizeText(record.text),
    );
    if (candidate === undefined || record.enforcement.kind === 'advisory')
      return record;
    const origins = [
      ...new Set([...(record.harvested?.origins ?? []), ...candidate.origins]),
    ];
    const occurrences = Math.max(
      record.harvested?.occurrences ?? 0,
      candidate.occurrences,
      origins.length,
    );
    if (
      record.harvested?.origins.length === origins.length &&
      record.harvested.occurrences === occurrences
    )
      return record;
    promoted.push(record.id);
    return { ...record, harvested: { origins, occurrences } };
  });
  return { pack: next, promoted };
}

/** The lesson a row whose merged tree failed the upstream fix's held-back test leaves. */
export const HIDDEN_FAILURE_LESSON =
  "Run the task's own described behavior against its receiver before shipping: a merged change failed the upstream fix's held-back test.";
/** The lesson a row whose unattended drain exited non-zero leaves. */
export const DRAIN_FAILURE_LESSON =
  'Leave no ready task unshipped: an unattended drain exited non-zero or merged fewer pull requests than it opened.';
/** The lesson a merged KRN fix commit leaves. */
export const FIX_COMMIT_LESSON =
  'Verify the change against its receiver before shipping: a merged pull request was later changed or reverted.';

/** The `krn standards propose` arguments a finished row adds: one for a failed hidden test, one for a non-zero drain. */
export function failureArgs(
  stack: string,
  hidden: string,
  drainExit: number | undefined,
): string[][] {
  const args = (text: string, evidence: string) => [
    'standards',
    'propose',
    '--text',
    text,
    '--kind',
    'check',
    '--evidence',
    evidence,
  ];
  return [
    ...(hidden === 'fail'
      ? [args(HIDDEN_FAILURE_LESSON, `outside:${stack}:hidden`)]
      : []),
    ...(drainExit !== undefined && drainExit !== 0
      ? [args(DRAIN_FAILURE_LESSON, `outside:${stack}:drain:${drainExit}`)]
      : []),
  ];
}

/** The first markdown table of an audit report as `record -> [cell per repository]`, with its repository names. */
export function auditTable(markdown: string): {
  repositories: string[];
  cells: Map<string, string[]>;
} {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^\| record \|/u.test(line));
  if (start < 0) throw new Error('audit table: no "| record |" header');
  const split = (line: string): string[] =>
    line
      .replace(/^\||\|\s*$/gu, '')
      .split('|')
      .map((part) => part.trim());
  const repositories = split(lines[start] ?? '').slice(1);
  const cells = new Map<string, string[]>();
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    const [id = '', ...rest] = split(line);
    cells.set(id, rest);
  }
  return { repositories, cells };
}

/**
 * One proposal per repository whose audit cell FAILs for a record that fails in at least two
 * repositories; the proposal states the record's own text, so a promotable candidate marks it.
 */
export function auditFailProposals(
  markdown: string,
  pack: readonly Pick<UnifiedRecord, 'id' | 'text'>[],
  recordedAt: string,
): Sourced[] {
  const { repositories, cells } = auditTable(markdown);
  return [...cells.entries()].flatMap(([id, row]) => {
    const record = pack.find((entry) => entry.id === id);
    const failing = repositories.filter((_, i) => row[i] === 'FAIL');
    if (record === undefined || failing.length < 2) return [];
    return failing.map((repository) => ({
      origin: repository,
      repository: `audit:${repository}`,
      file: `standards-audit#${id}`,
      proposal: {
        text: record.text,
        kind: 'check' as const,
        evidence: [`evals/standards-audit.md#${id}`],
        recorded_at: recordedAt,
      },
    }));
  });
}

const FIX_SUBJECT = /^fix(?:\([^)]*\))?!?: .*\(#(\d+)\)$/u;

/** One proposal per merged `fix` commit whose subject ends in `(#PR)`, from `git log --format=%s` lines. */
export function fixCommitProposals(
  subjects: readonly string[],
  origin: string,
  recordedAt: string,
): Sourced[] {
  return subjects.flatMap((subject) => {
    const number = FIX_SUBJECT.exec(subject)?.[1];
    return number === undefined
      ? []
      : [
          {
            origin,
            repository: origin,
            file: `git#${number}`,
            proposal: {
              text: FIX_COMMIT_LESSON,
              kind: 'check' as const,
              evidence: [`#${number}`],
              recorded_at: recordedAt,
            },
          },
        ];
  });
}
