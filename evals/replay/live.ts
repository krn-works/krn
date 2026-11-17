// Live arm-A screening: one headless claude session per unit in a fresh checkout of unit.base, the task text as the only
// prompt, every session inside a host-wide session slot, then the unit's hidden test grades the result into a row.
// KRN_EVAL_CLAUDE names the claude binary (default `claude`); KRN_EVAL_MAX_SESSIONS caps live sessions host-wide.
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { outsideGit } from '../../src/cli/outside-git.ts';
import { withSessionSlot } from '../session-slot.ts';
import { withoutBrowser } from '../units/no-browser.ts';
import { requireSandbox } from '../units/sandbox.ts';
import { forceRemove, gradeWorktree } from '../units/screening.ts';
import type { Unit } from '../units/unit.ts';
import { ARMS, type Arm } from './arms.ts';
import { formatRow, type Row } from './rows.ts';
import { eligible, readRows, type ScreenUnit } from './screen.ts';

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
  // The session runs the repository's own tests, which may open a URL (t-nsk5wca).
  return withoutBrowser(env, join(scratch, 'no-browser'));
}

interface Session {
  cost: number;
  /** False when the session never ran to a result (spawn error, usage limit, crash): its row stays ungraded. */
  ran: boolean;
}

/**
 * Reads `claude -p --output-format json` output. A session ran when it printed a result that is not an error, or when
 * the time limit killed it (the arm had its full budget). Anything else, such as a usage-limit result, is not evidence
 * about the arm.
 */
export function sessionOf(out: string, timedOut: boolean): Session {
  let r: { total_cost_usd?: unknown; is_error?: unknown } | undefined;
  try {
    r = JSON.parse(out) as typeof r;
  } catch {
    // Not JSON: no result line.
  }
  const cost = typeof r?.total_cost_usd === 'number' ? r.total_cost_usd : 0;
  return { cost, ran: timedOut || (r !== undefined && r.is_error !== true) };
}

function runClaude(
  cwd: string,
  prompt: string,
  env: NodeJS.ProcessEnv,
  ms: number,
  log: string,
): Promise<Session> {
  const bin = env.KRN_EVAL_CLAUDE ?? 'claude';
  return new Promise((resolve) => {
    const p = spawn(
      bin,
      [
        '-p',
        '--output-format',
        'json',
        '--permission-mode',
        'bypassPermissions',
        '--disallowedTools',
        DENIED_TOOLS.join(','),
        '--setting-sources',
        'project',
      ],
      { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true },
    );
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (p.pid) process.kill(-p.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, ms);
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.stderr.on('data', (d) => appendFileSync(log, d));
    p.on('error', (e) => appendFileSync(log, `spawn error: ${e}\n`));
    p.stdin.on('error', () => {});
    p.stdin.end(prompt);
    p.on('close', () => {
      clearTimeout(timer);
      appendFileSync(log, out);
      resolve(sessionOf(out, timedOut));
    });
  });
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
  // Absolute: the session repository fetches from it with `git -C <session>`, which would resolve a relative path there.
  const clone = resolve(o.sources, unit.repo.replace('/', '__'));
  mkdirSync(o.scratch, { recursive: true });
  const log = join(o.scratch, `${unit.id}-${rep}.log`);
  try {
    local(clone, 'cat-file', '-e', `${unit.base}^{commit}`);
  } catch {
    local(clone, 'fetch', '-q', 'origin', unit.base);
  }
  // The session gets its own repository holding only the unit.base commit and no remote: a worktree of the clone
  // reached origin/main and the reference fix through shared refs and objects (unit t-13axy56 read the upstream fix).
  // Depth 1 because the clones are partial: only the base tree's blobs are present locally.
  const wt = mkdtempSync(join(o.scratch, 'session-'));
  local(wt, 'init', '-q');
  local(wt, 'fetch', '-q', '--no-tags', '--depth', '1', clone, unit.base);
  local(wt, 'checkout', '-q', '--detach', unit.base);
  rmSync(join(wt, '.git', 'FETCH_HEAD'), { force: true });
  try {
    const session = await withSessionSlot(
      () => runClaude(wt, promptOf(unit), env, o.sessionMs ?? 30 * 60_000, log),
      slotEnv,
    );
    // The grade sees the session's source change on a fresh install: ignored leftovers of the session's own installs
    // or builds (node_modules, .venv, dist) are not part of a change and can break the grading install.
    if (session.ran) local(wt, 'clean', '-fdXq');
    const g = session.ran
      ? await gradeWorktree(wt, unit, dir, log, o.scratch)
      : undefined;
    return {
      unit: unit.id,
      arm: arm.id,
      rep,
      pass: g ? g.install === 0 && g.test === 0 : null,
      cost: session.cost,
      harness: o.harness,
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
