// The successor launch log: one appended JSON line per launch.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type LaunchLogRow = {
  launched_at: string;
  name: string;
  agent: string;
  via: 'herdr' | 'background';
  tab_id?: string;
  pane_id?: string;
  task?: string;
};

/** The append-only log of every successor launch; retirement keeps its own panes ledger. */
export function launchLogPath(cwd: string): string {
  return join(cwd, '.krn', 'successors', 'launches.jsonl');
}

/** Appends one row; a log that cannot be written never fails the launch. */
export function logLaunch(cwd: string, row: Omit<LaunchLogRow, 'launched_at'>) {
  const path = launchLogPath(cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({ launched_at: new Date().toISOString(), ...row })}\n`,
    );
  } catch {
    process.stderr.write('successor: launch log unavailable\n');
  }
}
