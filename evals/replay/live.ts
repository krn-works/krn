// Live arm-A screening: one headless claude session per unit in a fresh checkout of unit.base, the task text as the only
// prompt, every session inside a host-wide session slot, then the unit's hidden test grades the result into a row.
// KRN_EVAL_CLAUDE names the claude binary (default `claude`); KRN_EVAL_MAX_SESSIONS caps live sessions host-wide.
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { budgetShortfall } from '../../src/repo/disk-budget.ts';
import { withoutBrowser } from '../units/no-browser.ts';
import { requireSandbox } from '../units/sandbox.ts';
import {
  forceRemove,
  refuseScratchInRepository,
  withoutAppGh,
} from '../units/screening.ts';
import type { Unit } from '../units/unit.ts';
import { liveAttempt, type SessionTurn } from './arm-session.ts';
import { ARMS, type Arm } from './arms.ts';
import {
  type GradeCheck,
  preflightOnce,
  sandboxedCommitGrade,
} from './grade-preflight.ts';
import { baseCheckout, recordGrade, recordPatch } from './recording.ts';
import { formatRow, type Row } from './rows.ts';
import { eligible, readRows, type ScreenUnit } from './screen.ts';
import type { DrivenSession } from './session.ts';
import { SESSION_MS } from './session-args.ts';

/** The exit code of a replay run that stopped on the disk budget (src/repo/disk-budget.ts) before cloning another unit. */
export const DISK_BUDGET_EXIT = 73;

export class DiskBudgetError extends Error {
  readonly exitCode = DISK_BUDGET_EXIT;
}

export interface LiveOptions {
  /** Free-space probe in GB per directory (tests pass a stub); defaults to the host's statfs. */
  freeGb?: ((dir: string) => number | undefined) | undefined;
  /** Directory of clones named <owner>__<name>. */
  sources: string;
  /** Scratch directory for session checkouts and logs. */
  scratch: string;
  rowsFile: string;
  harness: string;
  env?: NodeJS.ProcessEnv;
  /** Milliseconds one session may run. */
  sessionMs?: number;
  /** Sessions per unit; a unit passes when any rep passes. */
  reps?: number;
  /** The session model; a Codex model runs on `codex exec` (session-args.ts). Unset keeps the shared default. */
  model?: string | undefined;
  /** Directory that receives each graded session's patch and grade (recording.ts); none when unset. */
  recordings?: string | undefined;
  /** Runs the session; the default is the sandboxed driver. Tests pass a recorded one. */
  session?: (
    wt: string,
    env: NodeJS.ProcessEnv,
    log: string,
    turn?: SessionTurn,
  ) => Promise<DrivenSession>;
  /**
   * The grade preflight (grade-preflight.ts): the unit's grader red at base and green at the reference, before any
   * session. Default: the sandboxed grade of both commits when no session stub is given; tests pass a stub.
   */
  gradeCheck?: ((lu: LiveUnit) => Promise<GradeCheck>) | undefined;
  /** Resolves the unit's toolchain before any session (arm-session.ts); tests pass a stub. */
  preflight?: (
    wt: string,
    env: NodeJS.ProcessEnv,
    log: string,
  ) => Promise<number>;
}

export interface LiveUnit {
  unit: Unit;
  /** Directory holding unit.json and the hidden test file. */
  dir: string;
}

/** The prompt of arm A: the unit's task text and nothing else. */
export const promptOf = (u: Unit): string =>
  `${u.task.title}\n\n${u.task.body}`;

/** GitHub credentials and repository pointers an arm session never inherits. */
const GITHUB_VARS = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_REPO',
  'GH_CONFIG_DIR',
]);

/** Tools a screened session may not call: the web holds the upstream issue, pull request and fix. */
export const DENIED_TOOLS = ['WebFetch', 'WebSearch'] as const;

/**
 * The session environment of an arm. Arm A is a plain clone (krn: false, staticRecords: false): it gets no KRN
 * variables and a private Claude config directory holding only a link to the host's login, so neither user hooks,
 * user settings nor the user CLAUDE.md load; `--setting-sources project` keeps only what the checkout itself carries.
 * The session carries no GitHub credentials (ADR 0021): a public upstream stays reachable unauthenticated through curl
 * or git, which the contamination scan (contamination.ts) detects from the session transcript.
 */
export function armEnv(
  arm: Arm,
  scratch: string,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (arm.krn || arm.staticRecords)
    throw new Error(
      `arm ${arm.id} is not a plain clone: live screening runs arm A only`,
    );
  return isolatedEnv(scratch, base);
}

/**
 * The isolated session environment every live arm shares: no KRN or GitHub variables, a private Claude config holding
 * only the host login, scratch temporaries and no browser. An arm that adds KRN does so through the checkout's own
 * project settings, which `--setting-sources project` still loads.
 */
export function isolatedEnv(
  scratch: string,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base))
    if (
      (!k.startsWith('KRN_') || k.startsWith('KRN_EVAL_')) &&
      !GITHUB_VARS.has(k)
    )
      env[k] = v;
  // No GitHub identity: with no token and an empty gh config, `gh pr view -R <upstream>` fails with an auth error
  // instead of handing the session the upstream fix (S7: t-1d7k0sg read `gh pr diff -R` and passed).
  env.GH_CONFIG_DIR = join(scratch, 'gh-config');
  // scripts/app-bin/gh mints a GitHub App token on every call: on the session's PATH it would undo the empty config.
  env.PATH = withoutAppGh(env.PATH);
  mkdirSync(env.GH_CONFIG_DIR, { recursive: true });
  const dir = join(scratch, 'claude-config');
  mkdirSync(dir, { recursive: true });
  const login = join(
    base.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    '.credentials.json',
  );
  const link = join(dir, '.credentials.json');
  if (existsSync(login) && !existsSync(link)) symlinkSync(login, link);
  env.CLAUDE_CONFIG_DIR = dir;
  // The session's own builds write temporaries inside scratch: the host /tmp is a size-capped tmpfs.
  env.TMPDIR = join(scratch, 'tmp');
  mkdirSync(env.TMPDIR, { recursive: true });
  // Claude Code's own shell tool writes under CLAUDE_CODE_TMPDIR: a host value names a path the sandbox shows read-only.
  env.CLAUDE_CODE_TMPDIR = env.TMPDIR;
  // The session runs the repository's own tests, which may open a URL (t-nsk5wca).
  return withoutBrowser(env, join(scratch, 'no-browser'));
}

/** The real gh's exit status: scripts/app-bin/gh mints a GitHub App token per call and fails without one, so it never counts. */
export function realGhVersionStatus(path: string | undefined): number | null {
  return spawnSync('gh', ['--version'], {
    env: { ...process.env, PATH: withoutAppGh(path) },
  }).status;
}

/**
 * The host paths a sandboxed session writes: its checkout, its scratch (config, TMPDIR, stub openers) and the host
 * login file the private config links to, so a token refresh still reaches the host login.
 */
export function sessionWritable(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const w = [cwd];
  if (env.CLAUDE_CONFIG_DIR) {
    w.push(dirname(env.CLAUDE_CONFIG_DIR));
    const link = join(env.CLAUDE_CONFIG_DIR, '.credentials.json');
    if (existsSync(link)) w.push(realpathSync(link));
  }
  return w;
}

/** One arm-A session and its grade; the session holds a slot, the grade does not. */
export async function screenUnit(
  { unit, dir }: LiveUnit,
  o: LiveOptions,
  rep = 1,
  onRow?: (row: Row) => void,
): Promise<Row> {
  const arm = ARMS.A;
  const slotEnv = o.env ?? process.env;
  const env = armEnv(arm, o.scratch, slotEnv);
  const log = join(o.scratch, `${unit.id}-${rep}.log`);
  // The session gets its own repository holding only the unit.base commit and no remote (unit t-13axy56 read the
  // upstream fix through a worktree's shared refs).
  const wt = baseCheckout(o.sources, unit, o.scratch);
  try {
    // The change is recorded before the grade writes the hidden test into the checkout; a failed recording keeps the row.
    let patch: string | undefined;
    const a = await liveAttempt(arm, { unit, dir }, wt, env, log, {
      ...o,
      harness: o.harness,
      sessionMs: o.sessionMs ?? SESSION_MS,
      beforeGrade: (w) => {
        if (o.recordings === undefined) return;
        try {
          patch = recordPatch(w, o.recordings, unit.id, rep, unit.base);
        } catch (e) {
          appendFileSync(log, `record: ${String(e)}\n`);
        }
      },
    });
    if (a.grade && patch !== undefined && o.recordings !== undefined)
      recordGrade(o.recordings, {
        unit: unit.id,
        rep,
        base: unit.base,
        pass: a.grade.install === 0 && a.grade.test === 0,
        install: a.grade.install,
        test: a.grade.test,
        harness: o.harness,
      });
    const row: Row = {
      unit: unit.id,
      arm: arm.id,
      rep,
      pass: a.pass,
      harness: o.harness,
      ...a.row,
    };
    // The row is written before the scratch goes: a stopped run keeps every finished unit's row.
    onRow?.(row);
    return row;
  } finally {
    // A session may leave read-only trees (envtest binaries, a Go module cache); a failed removal never loses the row.
    try {
      forceRemove(wt);
    } catch (e) {
      appendFileSync(log, `cleanup: ${String(e)}\n`);
    }
  }
}

/** A row with no grade that a rerun would not change: the session made no attempt, or the unit was screened out. */
const settled = (r: Row): boolean =>
  r.verdict === 'no-attempt' || r.verdict === 'screened';

/** Screens every eligible unit's missing arm-A reps, at most the slot cap at a time, appending one row each. */
export async function screenLive(
  units: LiveUnit[],
  o: LiveOptions,
): Promise<Row[]> {
  // Refuse before any paid session when the grade could not run sandboxed or would abort on a scratch inside a repository.
  const stopOnBudget = () => {
    const short = budgetShortfall([o.scratch, dirname(o.rowsFile)], o.freeGb);
    if (short)
      throw new DiskBudgetError(
        `replay disk budget: only ${short.free.toFixed(1)} GB free under ${short.dir} (minimum ${short.minFree} GB, KRN_LANE_MIN_FREE_GB); stopped before cloning the next unit, rows so far are kept in ${o.rowsFile}`,
      );
  };
  stopOnBudget();
  requireSandbox();
  refuseScratchInRepository(o.scratch);
  const ok = new Set(
    eligible(units.map((u) => u.unit as ScreenUnit)).map((u) => u.id),
  );
  const done = new Set(
    readRows(o.rowsFile)
      .filter((r) => r.arm === 'A' && (r.pass !== null || settled(r)))
      .map((r) => `${r.unit}/${r.rep}`),
  );
  const todo = units
    .filter((u) => ok.has(u.unit.id))
    .flatMap((u) =>
      Array.from({ length: o.reps ?? 1 }, (_, i) => ({ u, rep: i + 1 })),
    )
    .filter((t) => !done.has(`${t.u.unit.id}/${t.rep}`));
  const rows: Row[] = [];
  // The grade preflight runs for every unit before the first session: a unit its grader cannot grade gets one
  // screened row per missing rep and no session. Its log sits beside the rows, outside the scratch a session writes.
  const check =
    o.gradeCheck ??
    (o.session === undefined
      ? preflightOnce(
          sandboxedCommitGrade(o),
          join(dirname(o.rowsFile), 'grade-preflight'),
        )
      : undefined);
  const checks = new Map<string, GradeCheck>();
  if (check !== undefined)
    for (const u of new Set(todo.map((t) => t.u)))
      checks.set(u.unit.id, await check(u));
  const runnable = todo.filter((t) => {
    const c = checks.get(t.u.unit.id);
    if (c === undefined || c.ok) return true;
    const row: Row = {
      unit: t.u.unit.id,
      arm: ARMS.A.id,
      rep: t.rep,
      pass: null,
      cost: null,
      harness: o.harness,
      model: null,
      verdict: 'screened',
      screenedOut: `grade preflight: ${c.reasons.join('; ')}`,
      ...(c.tail ? { gradeTail: c.tail } : {}),
    };
    appendFileSync(o.rowsFile, `${formatRow(row)}\n`);
    rows.push(row);
    return false;
  });
  let next = 0;
  const width = Math.max(
    1,
    Number((o.env ?? process.env).KRN_EVAL_MAX_SESSIONS) || 4,
  );
  let stopped: DiskBudgetError | undefined;
  const work = async () => {
    while (next < runnable.length && !stopped) {
      try {
        stopOnBudget();
      } catch (e) {
        stopped = e as DiskBudgetError;
        return;
      }
      const t = runnable[next++] as (typeof runnable)[number];
      await screenUnit(t.u, o, t.rep, (row) => {
        appendFileSync(o.rowsFile, `${formatRow(row)}\n`);
        rows.push(row);
      });
    }
  };
  await Promise.all(Array.from({ length: width }, work));
  if (stopped) throw stopped;
  return rows;
}
