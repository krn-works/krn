// The one results format: (unit, arm, rep, pass, cost, harness sha, realized model). `pass` is null until a session is graded.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ArmId } from './arms.ts';
import type { Verdict } from './attempt.ts';

export interface Row {
  unit: string;
  arm: ArmId;
  rep: number;
  pass: boolean | null;
  /** USD for the session; null when the session reported none (unknown, never 0) and for a dry row. */
  cost: number | null;
  harness: string;
  /** The model the session realized (its usage keys, sorted and joined); null when unreported, absent on older rows. */
  model?: string | null;
  /** Tokens the arm's instruction text carried into the session (arms B and C attest the same figure); absent for A. */
  injection?: number;
  /** How the attempt ended (attempt.ts): a no-attempt or a screened-out unit is reported apart from a fail. */
  verdict?: Verdict;
  /** Why the unit was screened out before any session (its toolchain did not resolve). */
  screenedOut?: string;
  /**
   * Session time: wall time of the attempt's sessions from the first one's start, the gate's re-prompt included. The
   * attempt's time cap is measured on it; the wait for a host session slot is not.
   */
  durationMs?: number;
  /** Wall time the attempt waited for a host session slot before its first session started. */
  queueMs?: number;
  /** Part of `durationMs` the host spent suspended; a kill cannot land while it sleeps, so such a row can pass its cap. */
  hostSleepMs?: number;
  toolCalls?: number;
  /** Test commands the attempt's sessions ran. */
  testsRun?: number;
  /** Why the attempt's last session ended: end_turn, cap (its time or dollar cap) or a failure subtype. */
  stopReason?: string;
  /** The verify-before-end gate refused the first end and re-prompted once. */
  reprompted?: boolean;
  /** The session's passing change broke a test that passed at the base commit; absent while no grader measures it. */
  regressed?: boolean;
  /** Exit of the unit repo's own suite on the changed tree (hidden file removed); -1 when its install failed. Set only for a passing rep. */
  afterSuite?: number;
  /** Exit of the same suite on a fresh base checkout; run only when `afterSuite` was red, so absent when it was green. */
  baseSuite?: number;
  /** The last ~40 lines of the grader's output (screening.ts TAIL_LINES), so every verdict is auditable. */
  gradeTail?: string;
}

/** Every file the harness runs: the replay directory and the d23 and units code its sessions and grades import. */
const harnessDirs = (dir: string): string[] => [
  dir,
  join(dir, '..', 'd23'),
  join(dir, '..', 'units'),
];

/** Content hash of every .ts file the replay harness runs, so a change to a grader or analysis changes it. */
export function harnessSha(dir: string): string {
  const h = createHash('sha256');
  for (const d of harnessDirs(dir)) {
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      continue;
    }
    for (const f of names) {
      if (!f.endsWith('.ts')) continue;
      h.update(`${basename(d)}/${f}`);
      h.update(readFileSync(join(d, f)));
    }
  }
  return h.digest('hex').slice(0, 12);
}

export const formatRow = (r: Row): string => JSON.stringify(r);
