// The standards block SessionStart injects into an interactive session of an adopted repository:
// the records that match the session's claimed task (title, Outcome, Files, stack, area, touched
// paths) within SESSION_BUDGET tokens, logged to the exposure log under that task so `krn standards
// effect` counts the session as served. A session with no claimed task (a resumed lead session) is
// keyed by the tail of its own transcript instead, so the lead records it needs reach it too.
import { existsSync, readFileSync } from 'node:fs';
import { appendExposure, exposureOf } from '../brain/exposures.ts';
import { SERVE_POLICY } from '../brain/packet.ts';
import {
  claimedTask,
  taskQueryText,
  touchedPaths,
} from '../brain/task-query.ts';
import { lanePacket, SESSION_BUDGET } from '../brain/worker-packet.ts';

/** Characters of a resumed transcript's end that key retrieval when no task is claimed. */
const TAIL_CHARS = 4000;

/** The words a resumed session was last working on: user and assistant text, tool commands and tool results, newest last. */
export function transcriptTail(path: string, chars = TAIL_CHARS): string {
  if (!existsSync(path)) return '';
  const parts: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string') parts.push(value);
  };
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (typeof content === 'string') add(content);
    else if (Array.isArray(content))
      for (const block of content as Record<string, unknown>[]) {
        add(block.text);
        add((block.input as { command?: unknown } | undefined)?.command);
        const result = block.content;
        if (typeof result === 'string') add(result);
        else if (Array.isArray(result))
          for (const part of result as Record<string, unknown>[])
            add(part.text);
      }
  }
  return parts.join('\n').slice(-chars);
}

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
  transcriptPath?: string,
): string | undefined {
  const key = claimedTask(repo, main, branch);
  const tail =
    key === undefined && transcriptPath !== undefined
      ? transcriptTail(transcriptPath)
      : '';
  if (key === undefined && tail === '') return undefined;
  const packet = lanePacket(
    repo,
    key === undefined ? tail : taskQueryText(key, touchedPaths(repo)),
    asOf,
    key?.id ?? run,
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
        task: key?.id ?? run,
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
  return `Standards for this ${key === undefined ? 'session' : 'task'} (${packet.records.length}; ${SERVE_POLICY}):\n${packet.text}`;
}
