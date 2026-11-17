// A live replay row for an arm that runs through the session driver (arms B and C): the unit's base checkout is
// prepared by the arm, one headless session runs in the same bubblewrap sandbox and egress proxy as arm A, and the
// unit's hidden test grades the result into a row.
import { appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { outsideGit } from '../../src/cli/outside-git.ts';
import { withSessionSlot } from '../session-slot.ts';
import { SESSION_HOSTS, startEgress } from '../units/egress.ts';
import { requireSandbox, sandboxArgv } from '../units/sandbox.ts';
import { forceRemove, gradeWorktree } from '../units/screening.ts';
import type { Arm } from './arms.ts';
import {
  isolatedEnv,
  type LiveUnit,
  promptOf,
  sessionWritable,
} from './live.ts';
import { baseCheckout } from './recording.ts';
import type { Row } from './rows.ts';
import { type DrivenSession, driveSession } from './session.ts';
import { sessionCommand, settingsPath } from './session-args.ts';

export interface ArmOptions {
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

/** Commits the arm's checkout preparation, so the session's change is the only uncommitted work. */
export function commitPreparation(wt: string, message: string): void {
  outsideGit(wt, ['add', '-A']);
  outsideGit(wt, [
    '-c',
    'user.name=krn-eval',
    '-c',
    'user.email=krn-eval@localhost',
    'commit',
    '-qm',
    message,
  ]);
}

/** The sandboxed session of an arm: the shared session command, the unit's task as the brief. */
async function sandboxedSession(
  arm: Arm,
  wt: string,
  prompt: string,
  env: NodeJS.ProcessEnv,
  o: ArmOptions,
): Promise<DrivenSession> {
  const bin = env.KRN_EVAL_CLAUDE ?? 'claude';
  const settings = settingsPath(arm.id, env, wt);
  writeFileSync(settings, '{}\n');
  const cmd = sessionCommand({
    bin,
    prompt,
    settings,
    ...(o.model === undefined ? {} : { model: o.model }),
    ...(o.budgetUsd === undefined ? {} : { budgetUsd: o.budgetUsd }),
  });
  const egress = await startEgress(tmpdir(), SESSION_HOSTS);
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

/**
 * One session of `arm` on a checkout `prepare` has set up, and its grade; the session holds a slot, the grade does not.
 * `prepare` runs inside the checkout's lifetime and may return a note the caller keeps (token counts).
 */
export async function armRow<Note>(
  arm: Arm,
  { unit, dir }: LiveUnit,
  o: ArmOptions,
  rep: number,
  prepare: (wt: string, log: string) => Note,
): Promise<{ row: Row; note: Note }> {
  const slotEnv = o.env ?? process.env;
  const env = isolatedEnv(o.scratch, slotEnv);
  const log = join(o.scratch, `${unit.id}-${arm.id}-${rep}.log`);
  if (o.session === undefined) requireSandbox();
  const wt = baseCheckout(o.sources, unit, o.scratch);
  try {
    const note = prepare(wt, log);
    const run =
      o.session ??
      ((w: string, e: NodeJS.ProcessEnv) =>
        sandboxedSession(arm, w, promptOf(unit), e, o));
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
      row: {
        unit: unit.id,
        arm: arm.id,
        rep,
        pass: g ? g.install === 0 && g.test === 0 : null,
        cost: session.result.cost ?? null,
        harness: o.harness,
        model: session.result.model ?? null,
      },
      note,
    };
  } finally {
    try {
      forceRemove(wt);
    } catch (e) {
      appendFileSync(log, `cleanup: ${String(e)}\n`);
    }
  }
}
