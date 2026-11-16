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
import { join } from 'node:path';
import { outsideGit } from '../../src/cli/outside-git.ts';
import { withSessionSlot } from '../session-slot.ts';
import { gradeWorktree } from '../units/screening.ts';
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

/**
 * The session environment of an arm. Arm A is a plain clone (krn: false, staticRecords: false): it gets no KRN
 * variables and a private Claude config directory holding only a link to the host's login, so neither user hooks,
 * user settings nor the user CLAUDE.md load; `--setting-sources project` keeps only what the checkout itself carries.
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
    if (!k.startsWith('KRN_') || k.startsWith('KRN_EVAL_')) env[k] = v;
  const dir = join(scratch, 'claude-config');
  mkdirSync(dir, { recursive: true });
  const login = join(
    base.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    '.credentials.json',
  );
  const link = join(dir, '.credentials.json');
  if (existsSync(login) && !existsSync(link)) symlinkSync(login, link);
  env.CLAUDE_CONFIG_DIR = dir;
  return env;
}

interface Session {
  cost: number;
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
        '--setting-sources',
        'project',
      ],
      { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true },
    );
    let out = '';
    const timer = setTimeout(() => {
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
      let cost = 0;
      try {
        const c = (JSON.parse(out) as { total_cost_usd?: unknown })
          .total_cost_usd;
        if (typeof c === 'number') cost = c;
      } catch {
        // Not JSON: the cost stays unmeasured.
      }
      resolve({ cost });
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
  const clone = join(o.sources, unit.repo.replace('/', '__'));
  mkdirSync(o.scratch, { recursive: true });
  const log = join(o.scratch, `${unit.id}-${rep}.log`);
  try {
    local(clone, 'cat-file', '-e', `${unit.base}^{commit}`);
  } catch {
    local(clone, 'fetch', '-q', 'origin', unit.base);
  }
  const wt = mkdtempSync(join(o.scratch, 'session-'));
  rmSync(wt, { recursive: true });
  local(clone, 'worktree', 'add', '-q', '--detach', wt, unit.base);
  try {
    const session = await withSessionSlot(
      () => runClaude(wt, promptOf(unit), env, o.sessionMs ?? 30 * 60_000, log),
      slotEnv,
    );
    const g = await gradeWorktree(wt, unit, dir, log, o.scratch);
    return {
      unit: unit.id,
      arm: arm.id,
      rep,
      pass: g.install === 0 && g.test === 0,
      cost: session.cost,
      harness: o.harness,
    };
  } finally {
    if (existsSync(wt)) local(clone, 'worktree', 'remove', '--force', wt);
  }
}

/** Screens every eligible unit's missing arm-A reps, at most the slot cap at a time, appending one row each. */
export async function screenLive(
  units: LiveUnit[],
  o: LiveOptions,
): Promise<Row[]> {
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
