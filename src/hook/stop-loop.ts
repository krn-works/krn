import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Identical no-edit Stop refusals in a row after which the stop is allowed. */
export const STOP_LOOP_LIMIT = 3;

/** The note a refusal carries about where a run's full output was saved; its path differs on every run. */
export function failureLogNote(logPath: string): string {
  return `(full log: ${logPath})`;
}

/** A refusal without the per-run log path: the stable content the loop identity is taken from. */
export function stableRefusal(refusal: string): string {
  return refusal.replace(/\(full log: [^)\n]*\)/gu, '(full log)');
}

interface LoopState {
  fingerprint: string;
  count: number;
  verdict?: 'stop-loop';
}

/**
 * Counts a refusal of a session and says whether the session is stuck: the same refusal on the same
 * tree (`tree`: HEAD, status and diff of the checkout) for STOP_LOOP_LIMIT refusals in a row (the next Stop is allowed). A stuck session is recorded as a `stop-loop` verdict under
 * `.krn/runs/stop-loop/<session>.json`. State that cannot be read or written never blocks or releases.
 */
export function stuckInStopLoop(
  dir: string,
  session: unknown,
  refusal: string,
  tree: string,
): boolean {
  if (typeof session !== 'string' || !/^[\w-]+$/u.test(session)) return false;
  const file = join(dir, '.krn', 'runs', 'stop-loop', `${session}.json`);
  const fingerprint = createHash('sha256')
    .update(stableRefusal(refusal))
    .update(tree)
    .digest('hex');
  let previous: LoopState | undefined;
  try {
    previous = JSON.parse(readFileSync(file, 'utf8')) as LoopState;
  } catch {
    previous = undefined;
  }
  const count =
    previous?.fingerprint === fingerprint ? (previous.count ?? 0) + 1 : 1;
  const stuck = count > STOP_LOOP_LIMIT;
  const state: LoopState = {
    fingerprint,
    count,
    ...(stuck ? { verdict: 'stop-loop' as const } : {}),
  };
  try {
    mkdirSync(join(dir, '.krn', 'runs', 'stop-loop'), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state)}\n`);
  } catch {
    return false;
  }
  return stuck;
}
