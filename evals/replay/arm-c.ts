// Live arm C (KRN): the unit's base checkout adopts KRN (krn adopt writes the hooks, rules and contract), then one
// headless session runs through the session driver (session.ts) inside the same bubblewrap sandbox and egress proxy as
// arm A, and the unit's hidden test grades the result into a row.
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outsideGit } from '../../src/cli/outside-git.ts';
import { headlessArgs } from '../../src/harness/claude.ts';
import { shellWords } from '../../src/repo/shell-text.ts';
import { withSessionSlot } from '../session-slot.ts';
import { startEgress } from '../units/egress.ts';
import { requireSandbox, sandboxArgv } from '../units/sandbox.ts';
import { forceRemove, gradeWorktree } from '../units/screening.ts';
import {
  DENIED_TOOLS,
  isolatedEnv,
  type LiveUnit,
  promptOf,
  sessionWritable,
} from './live.ts';
import { baseCheckout } from './recording.ts';
import type { Row } from './rows.ts';
import { type DrivenSession, driveSession } from './session.ts';

const krnEntry = fileURLToPath(
  new URL('../../src/cli/krn.mjs', import.meta.url),
);

export interface ArmCOptions {
  sources: string;
  scratch: string;
  harness: string;
  env?: NodeJS.ProcessEnv;
  sessionMs?: number;
  model?: string;
  budgetUsd?: number;
  /** Runs the session; the default is the sandboxed driver. Tests pass a recorded one. */
  session?: (
    wt: string,
    env: NodeJS.ProcessEnv,
    log: string,
  ) => Promise<DrivenSession>;
}

/** Adopts KRN into the checkout and commits the adoption, so the session's change is the only uncommitted work. */
export function adoptKrn(wt: string, log: string): void {
  const r = spawnSync(process.execPath, [krnEntry, 'adopt', wt], {
    encoding: 'utf8',
    // Adoption of a large checkout took 96 s on 2026-11-17 (t-1182p41).
    timeout: 600_000,
  });
  appendFileSync(log, `adopt: exit ${r.status}\n${r.stdout}${r.stderr}`);
  if (r.status !== 0)
    throw new Error(`krn adopt exited ${r.status}: ${r.stderr.trim()}`);
  outsideGit(wt, ['add', '-A']);
  outsideGit(wt, [
    '-c',
    'user.name=krn-eval',
    '-c',
    'user.email=krn-eval@localhost',
    'commit',
    '-qm',
    'chore: adopt krn',
  ]);
}

/** The sandboxed session of arm C: KRN's headless lane arguments, the unit's task as the brief. */
async function sandboxedSession(
  wt: string,
  prompt: string,
  env: NodeJS.ProcessEnv,
  o: ArmCOptions,
): Promise<DrivenSession> {
  const bin = env.KRN_EVAL_CLAUDE ?? 'claude';
  const model = o.model ?? 'sonnet';
  const settings = join(dirname(env.CLAUDE_CONFIG_DIR ?? wt), 'arm-c.json');
  writeFileSync(settings, '{}\n');
  const cmd = shellWords([
    bin,
    ...headlessArgs({
      brief: prompt,
      settings,
      model,
      fallbackModel: model === 'sonnet' ? 'opus' : 'sonnet',
      budgetUsd: o.budgetUsd ?? 5,
      permissionMode: 'bypassPermissions',
    }),
    '--disallowedTools',
    DENIED_TOOLS.join(','),
  ]);
  const egress = await startEgress(tmpdir());
  try {
    return await driveSession({
      command: 'bwrap',
      argv: sandboxArgv(cmd, {
        cwd: wt,
        writable: [...sessionWritable(wt, env), dirname(settings)],
        ...(isAbsolute(bin) ? { readable: [dirname(bin)] } : {}),
        egress: egress.socket,
        env,
      }),
      cwd: wt,
      env,
      timeoutMs: o.sessionMs ?? 30 * 60_000,
      claude: bin,
    });
  } finally {
    await egress.close();
  }
}

/** One arm-C session on a KRN-adopted checkout and its grade; the session holds a slot, the grade does not. */
export async function armCRow(
  { unit, dir }: LiveUnit,
  o: ArmCOptions,
  rep = 1,
): Promise<Row> {
  const slotEnv = o.env ?? process.env;
  const env = isolatedEnv(o.scratch, slotEnv);
  const log = join(o.scratch, `${unit.id}-C-${rep}.log`);
  if (o.session === undefined) requireSandbox();
  const wt = baseCheckout(o.sources, unit, o.scratch);
  try {
    adoptKrn(wt, log);
    const run =
      o.session ??
      ((w: string, e: NodeJS.ProcessEnv) =>
        sandboxedSession(w, promptOf(unit), e, o));
    const session = await withSessionSlot(() => run(wt, env, log), slotEnv);
    appendFileSync(log, `${session.stdout}\n${session.stderr}\n`);
    // A session ran when it succeeded or used its whole time or budget; a usage-limit or crash result is no evidence.
    const ran =
      !session.notStarted &&
      (session.timedOut || session.result.ok || session.result.capped === true);
    if (ran) outsideGit(wt, ['clean', '-fdXq']);
    const g = ran
      ? await gradeWorktree(wt, unit, dir, log, o.scratch)
      : undefined;
    return {
      unit: unit.id,
      arm: 'C',
      rep,
      pass: g ? g.install === 0 && g.test === 0 : null,
      cost: session.result.cost ?? 0,
      harness: o.harness,
    };
  } finally {
    try {
      forceRemove(wt);
    } catch (e) {
      appendFileSync(log, `cleanup: ${String(e)}\n`);
    }
  }
}
