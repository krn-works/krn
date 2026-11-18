// One live lead per task: the launch ledger names the lead panes, the host says which still run.

import { readFileSync } from 'node:fs';
import { claudeAgent } from '../harness/claude.ts';
import { record, text } from './command.ts';
import { launchLogPath } from './launch-log.ts';
import type { SessionRef, TerminalHost } from './terminal-host.ts';

/** The launch refused because a lead session for the task is still live. */
export const EXIT_LEAD_LIVE = 73;

/**
 * The pane of a live Claude lead already launched for `task`, other than the
 * caller's own (a handoff retires its caller). A pane whose agent is gone or
 * done is not live; any other status, idle included, is.
 */
export function liveLeadPane(
  cwd: string,
  task: string,
  host: TerminalHost,
  callerPane: SessionRef | undefined,
): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(launchLogPath(cwd), 'utf8');
  } catch {
    return undefined;
  }
  for (const line of contents.split('\n').reverse()) {
    if (!line.trim()) continue;
    let row: Record<string, unknown> | undefined;
    try {
      row = record(JSON.parse(line));
    } catch {
      continue;
    }
    const pane = text(row?.pane_id);
    if (!pane || text(row?.task) !== task || pane === callerPane) continue;
    const info = host.agent(host.session(pane));
    if (info.notFound || info.agent !== claudeAgent) continue;
    if (info.status === 'done') continue;
    return pane;
  }
  return undefined;
}
