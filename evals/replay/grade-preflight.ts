// The grade preflight: before any session, a unit's exact grader must be red on unit.base (by assertion) and green on
// the unit's reference fix. A unit that fails either is screened out with the reason recorded and never gets a session:
// a grader that cannot tell the fix from the base would grade the model against the environment.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  baseVerdict,
  forceRemove,
  type Grade,
  gradeWorktree,
} from '../units/screening.ts';
import type { Unit } from '../units/unit.ts';
import type { LiveUnit } from './live.ts';
import { baseCheckout } from './recording.ts';

/** The preflight's finding: ok, or the reasons the grader cannot grade the unit and the failing grade's output tail. */
export interface GradeCheck {
  ok: boolean;
  reasons: string[];
  tail?: string;
}

/** Grades one commit's tree with the unit's hidden test; tests pass a recorded grader. */
export type CommitGrade = (
  sha: string,
  lu: LiveUnit,
  log: string,
) => Promise<Grade>;

/** Why the base grade cannot show a fix: it must install and fail by assertion, never pass, time out or not load. */
export function baseReasons(g: Grade): string[] {
  if (g.install !== 0) return [`base install exit ${g.install}`];
  const v = baseVerdict(g.test, g.compile);
  if (v === 'none') return ['hidden test passes at base'];
  if (v === 'timeout') return ['hidden test timed out at base'];
  if (v === 'compile') return ['hidden test does not load at base'];
  return [];
}

/** Why the reference grade fails: the reference fix must install and pass the exact grader. */
export function referenceReasons(g: Grade): string[] {
  if (g.install !== 0) return [`reference install exit ${g.install}`];
  if (g.test !== 0) return [`reference fails the grader (exit ${g.test})`];
  return [];
}

/** Both grades judged: the base must be red, the reference green; the tail is the reference's, else the base's. */
export function judge(base: Grade, reference: Grade): GradeCheck {
  const b = baseReasons(base);
  const r = referenceReasons(reference);
  const reasons = [...r, ...b];
  const tail = r.length > 0 ? reference.tail : b.length > 0 ? base.tail : '';
  return { ok: reasons.length === 0, reasons, ...(tail ? { tail } : {}) };
}

/** The default commit grade: a fresh checkout holding only `sha`, graded and removed (recording.ts baseCheckout). */
export function sandboxedCommitGrade(o: {
  sources: string;
  scratch: string;
}): CommitGrade {
  return async (sha, { unit, dir }, log) => {
    const wt = baseCheckout(
      o.sources,
      { ...unit, base: sha } as Unit,
      o.scratch,
    );
    try {
      appendFileSync(log, `\n== ${unit.id} ${sha}\n`);
      return await gradeWorktree(wt, unit, dir, log, o.scratch);
    } finally {
      try {
        forceRemove(wt);
      } catch (e) {
        appendFileSync(log, `cleanup: ${String(e)}\n`);
      }
    }
  };
}

/** Runs the preflight of one unit: base grade, then reference grade, judged together. */
export async function gradePreflight(
  lu: LiveUnit,
  grade: CommitGrade,
  log: string,
): Promise<GradeCheck> {
  mkdirSync(dirname(log), { recursive: true });
  const base = await grade(lu.unit.base, lu, log);
  const reference = await grade(lu.unit.reference, lu, log);
  const c = judge(base, reference);
  appendFileSync(
    log,
    `\npreflight ${lu.unit.id}: ${c.ok ? 'ok' : `screened (${c.reasons.join('; ')})`}\n`,
  );
  return c;
}

/**
 * One preflight per unit for a run, shared by every rep and arm that asks: concurrent askers wait on the same grade.
 * The log lives in `logDir`, outside the scratch a session may write.
 */
export function preflightOnce(
  grade: CommitGrade,
  logDir: string,
): (lu: LiveUnit) => Promise<GradeCheck> {
  const seen = new Map<string, Promise<GradeCheck>>();
  return (lu) => {
    let p = seen.get(lu.unit.id);
    if (p === undefined) {
      p = gradePreflight(
        lu,
        grade,
        join(logDir, `${lu.unit.id}-preflight.log`),
      );
      seen.set(lu.unit.id, p);
    }
    return p;
  };
}
