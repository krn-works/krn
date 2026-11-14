// The standards block SessionStart injects into an interactive session of an adopted repository:
// the records that match the session's task (branch, live claim, handoff) within SESSION_BUDGET
// tokens, logged to the exposure log so `krn standards effect` counts the session as served.
import { appendExposure, servedExposure } from '../brain/exposures.ts';
import { lanePacket, SESSION_BUDGET } from '../brain/worker-packet.ts';

/**
 * The block for one session, or undefined when the repository is not adopted or no record matches
 * `query` (the text naming the session's task). A served block is logged under `run`.
 */
export function sessionStandards(
  repo: string,
  main: string,
  run: string,
  query: string,
  asOf: string = new Date().toISOString().slice(0, 10),
): string | undefined {
  const packet = lanePacket(repo, query, asOf, 'session', SESSION_BUDGET);
  if (packet === null || packet.records.length === 0) return undefined;
  try {
    appendExposure(main, servedExposure(run, 'session', packet.records));
  } catch {
    /* The log is evidence, never a reason to lose the block. */
  }
  return `Standards for this task (${packet.records.length}):\n${packet.text}`;
}
