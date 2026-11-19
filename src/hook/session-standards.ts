// The standards block SessionStart injects into an interactive session of an adopted repository:
// the records that match the session's claimed task (title, Outcome, Files, stack, area, touched
// paths) within SESSION_BUDGET tokens, logged to the exposure log under that task so `krn standards
// effect` counts the session as served. A session with no claimed task gets no block.
import { appendExposure, exposureOf } from '../brain/exposures.ts';
import { SERVE_POLICY } from '../brain/packet.ts';
import {
  claimedTask,
  taskQueryText,
  touchedPaths,
} from '../brain/task-query.ts';
import { lanePacket, SESSION_BUDGET } from '../brain/worker-packet.ts';

/**
 * The block for one session, or undefined when the repository is not adopted, the session claims no
 * task, or no record matches the task. A served block is logged under `run`.
 */
export function sessionStandards(
  repo: string,
  main: string,
  run: string,
  branch: string,
  asOf: string = new Date().toISOString().slice(0, 10),
): string | undefined {
  const key = claimedTask(repo, main, branch);
  if (key === undefined) return undefined;
  const packet = lanePacket(
    repo,
    taskQueryText(key, touchedPaths(repo)),
    asOf,
    key.id,
    SESSION_BUDGET,
    true,
    'lead',
  );
  if (packet === null || packet.records.length === 0) return undefined;
  try {
    appendExposure(
      main,
      exposureOf({
        run,
        task: key.id,
        channel: 'session',
        served: packet.records,
        withheld: [],
        laneOk: true,
        tokens: packet.tokens,
      }),
    );
  } catch {
    /* The log is evidence, never a reason to lose the block. */
  }
  return `Standards for this task (${packet.records.length}; ${SERVE_POLICY}):\n${packet.text}`;
}
