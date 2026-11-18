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
import { outsideGit } from '../../src/cli/outside-git.ts';
import { withSessionSlot } from '../session-slot.ts';
import { withoutBrowser } from '../units/no-browser.ts';
import { requireSandbox } from '../units/sandbox.ts';
import {
  forceRemove,
  gradeWorktree,
  withoutAppGh,
} from '../units/screening.ts';
import type { Unit } from '../units/unit.ts';
import { sandboxedSession } from './arm-session.ts';
import { ARMS, type Arm } from './arms.ts';
import { baseCheckout, recordGrade, recordPatch } from './recording.ts';
import { formatRow, type Row } from './rows.ts';
import { eligible, readRows, type ScreenUnit } from './screen.ts';
import { type DrivenSession, sessionRan } from './session.ts';

export interface LiveOptions {
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
  /** Directory that receives each graded session's patch and grade (recording.ts); none when unset. */
  recordings?: string | undefined;
  /** Runs the session; the default is the sandboxed driver. Tests pass a recorded one. */
  session?: (
    wt: string,
    env: NodeJS.ProcessEnv,
    log: string,
  ) => Promise<DrivenSession>;
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

const local = (repo: string, ...args: string[]) => outsideGit(repo, args);

/** One arm-A session and its grade; the session holds a slot, the grade does not. */
export async function screenUnit(
  { unit, dir }: LiveUnit,
  o: LiveOptions,
  rep = 1,
): Promise<Row> {
  const arm = ARMS.A;
  const slotEnv = o.env ?? process.env;
  const env = armEnv(arm, o.scratch, slotEnv);
  const log = join(o.scratch, `${unit.id}-${rep}.log`);
  // The session gets its own repository holding only the unit.base commit and no remote (unit t-13axy56 read the
  // upstream fix through a worktree's shared refs).
  const wt = baseCheckout(o.sources, unit, o.scratch);
  try {
    const run =
      o.session ??
      ((w: string, e: NodeJS.ProcessEnv) =>
        sandboxedSession(arm, w, promptOf(unit), e, {
          sessionMs: o.sessionMs ?? 30 * 60_000,
        }));
    const session = await withSessionSlot(() => run(wt, env, log), slotEnv);
    appendFileSync(log, `${session.stdout}\n${session.stderr}\n`);
    const ran = sessionRan(session);
    // The grade sees the session's source change on a fresh install: ignored leftovers of the session's own installs
    // or builds (node_modules, .venv, dist) are not part of a change and can break the grading install.
    if (ran) local(wt, 'clean', '-fdXq');
    // The change is recorded before the grade writes the hidden test into the checkout; a failed recording keeps the row.
    let patch: string | undefined;
    if (ran && o.recordings !== undefined)
      try {
        patch = recordPatch(wt, o.recordings, unit.id, rep, unit.base);
      } catch (e) {
        appendFileSync(log, `record: ${String(e)}\n`);
      }
    const g = ran
      ? await gradeWorktree(wt, unit, dir, log, o.scratch)
      : undefined;
    if (g && patch !== undefined && o.recordings !== undefined)
      recordGrade(o.recordings, {
        unit: unit.id,
        rep,
        base: unit.base,
        pass: g.install === 0 && g.test === 0,
        install: g.install,
        test: g.test,
        harness: o.harness,
      });
    return {
      unit: unit.id,
      arm: arm.id,
      rep,
      pass: g ? g.install === 0 && g.test === 0 : null,
      cost: session.result.cost ?? null,
      harness: o.harness,
      model: session.result.model ?? null,
    };
  } finally {
    // A session may leave read-only trees (envtest binaries, a Go module cache); a failed removal never loses the row.
    try {
      forceRemove(wt);
    } catch (e) {
      appendFileSync(log, `cleanup: ${String(e)}\n`);
    }
  }
}

/** Screens every eligible unit's missing arm-A reps, at most the slot cap at a time, appending one row each. */
export async function screenLive(
  units: LiveUnit[],
  o: LiveOptions,
): Promise<Row[]> {
  // Refuse before any paid session when the grade could not run sandboxed.
  requireSandbox();
  const ok = new Set(
    eligible(units.map((u) => u.unit as ScreenUnit)).map((u) => u.id),
  );
  const done = new Set(
    readRows(o.rowsFile)
      .filter((r) => r.arm === 'A' && r.pass !== null)
      .map((r) => `${r.unit}/${r.rep}`),
  );
  const todo = units
    .filter((u) => ok.has(u.unit.id))
    .flatMap((u) =>
      Array.from({ length: o.reps ?? 1 }, (_, i) => ({ u, rep: i + 1 })),
    )
    .filter((t) => !done.has(`${t.u.unit.id}/${t.rep}`));
  const rows: Row[] = [];
  let next = 0;
  const width = Math.max(
    1,
    Number((o.env ?? process.env).KRN_EVAL_MAX_SESSIONS) || 4,
  );
  const work = async () => {
    while (next < todo.length) {
      const t = todo[next++] as (typeof todo)[number];
      const row = await screenUnit(t.u, o, t.rep);
      appendFileSync(o.rowsFile, `${formatRow(row)}\n`);
      rows.push(row);
    }
  };
  await Promise.all(Array.from({ length: width }, work));
  return rows;
}
