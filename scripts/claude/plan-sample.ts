// Status line command: samples the account's plan windows (`rate_limits`) into
// `.krn/plan/samples.jsonl` of the main checkout and prints a one-line gauge.
// The payload shape is the receiver's own: spike-g captured it from an
// interactive Claude Code session (test/claude/plan-sample.test.ts carries it).
// Headless sessions never invoke a status line, so samples come from
// interactive sessions only; the percentages belong to the whole account.
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type PlanSample = {
  time: string;
  session: string;
  five_hour: number;
  seven_day: number;
  // Rows written before the account and resets were recorded lack these.
  account?: string;
  five_hour_resets?: string;
  seven_day_resets?: string;
};

// The payload names no account: the signed-in account's uuid comes from the
// Claude Code config file and is stored only as a short hash, never the uuid.
export function accountLabel(config: unknown): string | undefined {
  const uuid = object(object(config).oauthAccount).accountUuid;
  return typeof uuid === 'string' && uuid
    ? createHash('sha256').update(uuid).digest('hex').slice(0, 12)
    : undefined;
}

function configAccount(): string | undefined {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  const file = dir
    ? join(dir, '.claude.json')
    : join(homedir(), '.claude.json');
  try {
    return accountLabel(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

function field(key: string, value: string | undefined) {
  return value ? { [key]: value } : {};
}

function reset(limits: Record<string, unknown>, key: string) {
  const at = object(limits[key]).resets_at;
  return typeof at === 'number' && Number.isFinite(at)
    ? new Date(at * 1000).toISOString().replace(/\.\d{3}Z$/u, 'Z')
    : undefined;
}

// Tolerant: a missing or non-object field reads as empty, never throws.
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function percentage(limits: Record<string, unknown>, key: string) {
  const used = object(limits[key]).used_percentage;
  return typeof used === 'number' && Number.isFinite(used) ? used : undefined;
}

// Returns a sample only when both windows are present: the first status
// call of a session precedes the first API response and has no rate_limits.
export function sampleOf(
  payload: unknown,
  now: Date,
  account?: string,
): PlanSample | undefined {
  const input = object(payload);
  const limits = object(input.rate_limits);
  const five_hour = percentage(limits, 'five_hour');
  const seven_day = percentage(limits, 'seven_day');
  if (five_hour === undefined || seven_day === undefined) return undefined;
  return {
    time: now.toISOString().replace(/\.\d{3}Z$/u, 'Z'),
    session: typeof input.session_id === 'string' ? input.session_id : '',
    five_hour,
    seven_day,
    ...field('account', account),
    ...field('five_hour_resets', reset(limits, 'five_hour')),
    ...field('seven_day_resets', reset(limits, 'seven_day')),
  };
}

// Worktrees live under <main>/.krn/worktrees/<slug>; agent state belongs to
// the main checkout (KRN-08), resolved without spawning git on every refresh.
export function mainCheckout(directory: string) {
  // The innermost worktree segment wins: a checkout may itself sit inside a
  // worktree (test temp dirs under <worktree>/.krn/tmp).
  const at = directory.lastIndexOf('/.krn/worktrees/');
  return at === -1 ? directory : directory.slice(0, at);
}

// The session cwd may be any subdirectory: walk up to the nearest directory
// holding `.git` (a directory, or a file in a linked worktree), then strip the
// worktree suffix. Filesystem checks only; no git spawn. Undefined outside a repo.
export function stateRoot(directory: string) {
  let at = directory;
  for (;;) {
    const git = join(at, '.git');
    // A .git directory is a main checkout even under a worktree path; only a
    // .git file (a linked worktree) maps back to its main checkout.
    if (existsSync(git))
      return statSync(git).isDirectory() ? at : mainCheckout(at);
    const parent = dirname(at);
    if (parent === at) return undefined;
    at = parent;
  }
}

function lastSample(file: string): PlanSample | undefined {
  try {
    const size = statSync(file).size;
    const text = readFileSync(file, 'utf8').slice(Math.max(0, size - 4096));
    const line = text.trimEnd().split('\n').pop();
    return line ? (JSON.parse(line) as PlanSample) : undefined;
  } catch {
    return undefined;
  }
}

// Appends only when a window moved, so a refresh every few seconds adds a
// row per plan point, not per refresh.
export function record(root: string, sample: PlanSample) {
  const directory = join(root, '.krn/plan');
  const file = join(directory, 'samples.jsonl');
  const last = lastSample(file);
  if (
    last &&
    last.five_hour === sample.five_hour &&
    last.seven_day === sample.seven_day &&
    last.account === sample.account &&
    last.five_hour_resets === sample.five_hour_resets &&
    last.seven_day_resets === sample.seven_day_resets
  )
    return false;
  mkdirSync(directory, { recursive: true });
  appendFileSync(file, `${JSON.stringify(sample)}\n`);
  return true;
}

export function gauge(sample: PlanSample | undefined) {
  return sample
    ? `plan 5h ${sample.five_hour}% · 7d ${sample.seven_day}%`
    : 'plan —';
}

if (import.meta.main) {
  let sample: PlanSample | undefined;
  try {
    const payload = JSON.parse(readFileSync(0, 'utf8')) as unknown;
    sample = sampleOf(payload, new Date(), configAccount());
    const cwd = object(payload).cwd;
    const directory = typeof cwd === 'string' ? cwd : process.cwd();
    const root = sample ? stateRoot(directory) : undefined;
    if (sample && root) record(root, sample);
  } catch {
    // A status line must never fail the session; print the empty gauge.
  }
  process.stdout.write(`${gauge(sample)}\n`);
}
