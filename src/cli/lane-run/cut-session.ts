import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { worktreeUsers } from '../../repo/lane-removal.ts';

/** Where a lane's session records its process group: a cut run leaves it for the next run to find. */
export const sessionGroupFile = (main: string, lane: string): string =>
  join(main, '.krn', 'runs', lane, 'session.pgid');

export function recordSessionGroup(file: string, pgid: number): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${pgid}\n`);
}

export function forgetSessionGroup(file: string): void {
  rmSync(file, { force: true });
}

/** The process group of a pid, or undefined when it is gone or /proc cannot say. */
export function processGroupOf(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // "pid (comm) state ppid pgrp ...": comm may hold spaces and parentheses.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const pgrp = Number(rest[2]);
    return Number.isInteger(pgrp) ? pgrp : undefined;
  } catch {
    return undefined;
  }
}

export interface ReapOptions {
  users?: (path: string) => number[] | undefined;
  groupOf?: (pid: number) => number | undefined;
  kill?: (pgid: number) => void;
  waitMs?: number;
}

const killProcessGroup = (pgid: number): void => {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    /* Already gone. */
  }
};

/**
 * A run cut before its session ended leaves the session's process group alive, still writing in the lane worktree.
 * Before the worktree is reused, kill the recorded group when one of its processes works inside the worktree and
 * wait until none is left. Returns the pids that were killed. A recycled pgid with no member in the worktree is left alone.
 */
export async function reapCutSession(
  main: string,
  lane: string,
  worktree: string,
  options: ReapOptions = {},
): Promise<number[]> {
  const file = sessionGroupFile(main, lane);
  if (!existsSync(file)) return [];
  const pgid = Number(readFileSync(file, 'utf8').trim());
  forgetSessionGroup(file);
  if (!Number.isInteger(pgid) || pgid <= 1) return [];
  const users = options.users ?? worktreeUsers;
  const groupOf = options.groupOf ?? processGroupOf;
  const members = () =>
    (users(worktree) ?? []).filter((pid) => groupOf(pid) === pgid);
  const found = members();
  if (found.length === 0) return [];
  (options.kill ?? killProcessGroup)(pgid);
  const deadline = Date.now() + (options.waitMs ?? 10_000);
  while (members().length > 0 && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 25));
  if (members().length > 0)
    throw new Error(
      `session group ${pgid} still works in ${worktree} after SIGKILL`,
    );
  return found;
}
