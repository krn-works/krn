// `krn standards propose --from-candidate FILE`: a research candidate (`krn.candidate/v1`) enters a repository as a
// tracked file plus one trial record, and leaves with a `krn.verdict/v1` file. A candidate that names no failing
// case (`motivated_by`) is refused; one experiment and 10 USD a week is the cap (ADR 0017 point 6).
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { FormatError } from '../repo/formats.ts';
import { incidentMessage, judgePrinciple } from './principle-check.ts';
import { parseResearchCandidate, RESEARCH_DIR } from './proposals.ts';
import { parseUnified, RecordSchema } from './record.ts';
import { StandardsDataError } from './standards.ts';

/** Where verdict files live, relative to the repository root; the file is `<candidate id>.json`. */
export const VERDICT_DIR = '.agents/standards-proposals/verdicts';
/** Candidate experiments allowed per rolling week. */
export const WEEKLY_EXPERIMENTS = 1;
/** Spend allowed per rolling week across verdicts, in USD. */
export const WEEKLY_BUDGET_USD = 10;
const WEEK_MS = 7 * 86_400_000;

/** The weekly cap is reached: exit 75, try again once the window has passed. */
export class CandidateCapError extends Error {
  readonly exitCode = 75;
}

export const VERDICT_DECISIONS = ['accept', 'reject', 'inconclusive'] as const;

export type Verdict = {
  readonly schema: 'krn.verdict/v1';
  readonly id: string;
  readonly n: number;
  readonly delta: number;
  readonly p: number;
  readonly cost_usd: number;
  readonly decision: (typeof VERDICT_DECISIONS)[number];
  readonly recorded_at: string;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const VERDICT_KEYS = [
  'schema',
  'id',
  'n',
  'delta',
  'p',
  'cost_usd',
  'decision',
  'recorded_at',
];

function bad(where: string, message: string): never {
  throw new StandardsDataError(`${where}: ${message}`);
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    bad(where, 'expected an object');
  return value as Record<string, unknown>;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new StandardsDataError(
      `${path}: not readable JSON (${(error as Error).message})`,
    );
  }
}

/** A reader refuses an unknown major of `krn.<name>` with exit 78. */
function assertMajor(
  row: Record<string, unknown>,
  name: string,
  where: string,
) {
  const schema = row.schema;
  if (typeof schema !== 'string') return;
  const match = new RegExp(`^krn\\.${name}/v([0-9]+)$`, 'u').exec(schema);
  if (match !== null && match[1] !== '1')
    throw new FormatError(
      `${where}.schema: "${schema}" has major ${match[1]}, this build reads krn.${name}/v1`,
    );
}

export function parseVerdict(value: unknown, where = 'verdict'): Verdict {
  const v = object(value, where);
  assertMajor(v, 'verdict', where);
  for (const key of VERDICT_KEYS)
    if (!(key in v)) bad(`${where}.${key}`, 'is required');
  for (const key of Object.keys(v))
    if (!VERDICT_KEYS.includes(key))
      bad(`${where}.${key}`, 'is not a verdict field');
  if (v.schema !== 'krn.verdict/v1')
    bad(`${where}.schema`, 'expected "krn.verdict/v1"');
  if (typeof v.id !== 'string' || v.id === '')
    bad(`${where}.id`, 'expected a non-empty string');
  const count = (key: string, whole: boolean) => {
    const n = v[key];
    if (
      typeof n !== 'number' ||
      !Number.isFinite(n) ||
      (whole && !Number.isInteger(n)) ||
      (key !== 'delta' && n < 0)
    )
      bad(`${where}.${key}`, 'expected a number');
    return n;
  };
  if (
    typeof v.decision !== 'string' ||
    !(VERDICT_DECISIONS as readonly string[]).includes(v.decision)
  )
    bad(`${where}.decision`, `expected one of ${VERDICT_DECISIONS.join(', ')}`);
  if (typeof v.recorded_at !== 'string' || !DATE.test(v.recorded_at))
    bad(`${where}.recorded_at`, 'expected a YYYY-MM-DD date');
  return {
    schema: 'krn.verdict/v1',
    id: v.id,
    n: count('n', true),
    delta: count('delta', false),
    p: count('p', false),
    cost_usd: count('cost_usd', false),
    decision: v.decision as Verdict['decision'],
    recorded_at: v.recorded_at,
  };
}

function jsonFiles(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : [];
}

const withinWeek = (today: string, at: string): boolean => {
  const age = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${at}T00:00:00Z`);
  return age < WEEK_MS;
};

/** USD the verdicts of the last 7 days cost. */
export function weeklySpend(root: string, today: string): number {
  const dir = join(root, VERDICT_DIR);
  return jsonFiles(dir)
    .map((name) => parseVerdict(readJson(join(dir, name)), join(dir, name)))
    .filter((v) => withinWeek(today, v.recorded_at))
    .reduce((sum, v) => sum + v.cost_usd, 0);
}

/** Ingests one candidate file; returns the written candidate path, or undefined when it was already ingested. */
export function ingestCandidate(
  root: string,
  file: string,
  today: string,
): { readonly file: string; readonly created: boolean } {
  const raw = object(readJson(file), file);
  assertMajor(raw, 'candidate', file);
  const row: Record<string, unknown> = { recorded_at: today, ...raw };
  const candidate = parseResearchCandidate(row, file);
  if (!ID.test(candidate.id))
    bad(`${file}.id`, 'expected letters, digits, dots, dashes or underscores');
  for (const key of ['record_draft', 'experiment', 'expires'])
    if (!(key in row)) bad(`${file}.${key}`, 'is required');
  const draft = RecordSchema.safeParse(row.record_draft);
  if (!draft.success)
    bad(
      `${file}.record_draft`,
      draft.error.issues[0]?.message ?? 'not a krn.record/v1 object',
    );
  if (draft.data.status !== 'trial')
    bad(`${file}.record_draft.status`, 'expected "trial"');
  const verdict = judgePrinciple({
    text: draft.data.text,
    evidence: draft.data.provenance.evidence,
    enforced: draft.data.enforcement.kind !== 'advisory',
  });
  if (!verdict.principle)
    bad(`${file}.record_draft.text`, incidentMessage(verdict.signals));
  const experiment = object(row.experiment, `${file}.experiment`);
  for (const key of ['population', 'metric'])
    if (typeof experiment[key] !== 'string' || experiment[key] === '')
      bad(`${file}.experiment.${key}`, 'expected a non-empty string');
  if (typeof experiment.predicted_delta !== 'number')
    bad(`${file}.experiment.predicted_delta`, 'expected a number');
  if (!Number.isInteger(experiment.min_n) || (experiment.min_n as number) < 1)
    bad(`${file}.experiment.min_n`, 'expected a whole number of at least 1');
  if (typeof row.expires !== 'string' || !DATE.test(row.expires))
    bad(`${file}.expires`, 'expected a YYYY-MM-DD date');
  if (row.expires < today) bad(`${file}.expires`, `expired on ${row.expires}`);

  const dir = join(root, RESEARCH_DIR);
  const target = `${RESEARCH_DIR}/${candidate.id}.json`;
  if (existsSync(join(root, target))) return { file: target, created: false };
  const recent = jsonFiles(dir).filter((name) => {
    const at = object(readJson(join(dir, name)), name).recorded_at;
    return typeof at === 'string' && withinWeek(today, at);
  });
  if (recent.length >= WEEKLY_EXPERIMENTS)
    throw new CandidateCapError(
      `krn standards propose --from-candidate: weekly cap of ${WEEKLY_EXPERIMENTS} candidate experiment reached (${recent.join(', ')}); try again after 7 days`,
    );
  const spent = weeklySpend(root, today);
  if (spent >= WEEKLY_BUDGET_USD)
    throw new CandidateCapError(
      `krn standards propose --from-candidate: weekly budget of ${WEEKLY_BUDGET_USD} USD reached (${spent} USD spent in verdicts)`,
    );

  const recordsPath = join(root, '.agents/records.json');
  const existing = existsSync(recordsPath)
    ? (readJson(recordsPath) as Record<string, unknown>[])
    : [];
  const next = existing.some((r) => r.id === draft.data.id)
    ? existing
    : [...existing, row.record_draft as Record<string, unknown>];
  parseUnified(next);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, target), `${JSON.stringify(row, null, 2)}\n`);
  writeFileSync(recordsPath, `${JSON.stringify(next, null, 2)}\n`);
  return { file: target, created: true };
}
