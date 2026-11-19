import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

/** Where a ship keeps its pid and its log, inside the lane worktree (ignored state). */
export const shipPidPath = join('.krn', 'tmp', 'ship.pid');
export const shipLogPath = join('.krn', 'tmp', 'ship.log');

/** True when `pid` names a running process (a process we may not signal is still running). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  try {
    // A recycled pid belongs to another program: on Linux the live process must still be a ship.
    return /\bship\b/u.test(
      readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '),
    );
  } catch {
    return true;
  }
}

/** The pid of the live `krn pr ship` of a worktree, or undefined when none runs there. */
export function liveShipPid(worktree: string): number | undefined {
  try {
    const pid = Number(
      readFileSync(join(worktree, shipPidPath), 'utf8').trim(),
    );
    return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Records the calling ship process in its worktree; a directory that is not a worktree is left alone. */
export function markShipLive(worktree: string, pid = process.pid): void {
  try {
    if (!existsSync(join(worktree, '.git'))) return;
    mkdirSync(join(worktree, '.krn', 'tmp'), { recursive: true });
    writeFileSync(join(worktree, shipPidPath), `${pid}\n`);
  } catch {
    /* Evidence only: a ship never fails over its pid file. */
  }
}

/** Removes the pid file when it still names `pid`. */
export function clearShipLive(worktree: string, pid = process.pid): void {
  try {
    const file = join(worktree, shipPidPath);
    if (Number(readFileSync(file, 'utf8').trim()) === pid)
      rmSync(file, { force: true });
  } catch {
    /* Nothing recorded. */
  }
}

/**
 * The worktree a detached ship runs in and the ship arguments with `--worktree` and `--body-file` made
 * absolute. The child starts with the worktree as its cwd, so a relative path forwarded as given would
 * resolve against the worktree itself and name a file or directory that does not exist.
 */
export function detachedShipArgs(
  args: readonly string[],
  caller: string,
): { worktree: string; args: string[] } {
  const out = [...args];
  let worktree = resolve(caller);
  for (let i = 0; i < out.length; i++) {
    const arg = out[i] as string;
    if (arg === '--worktree') {
      worktree = resolve(caller, out[i + 1] ?? '.');
      out[i + 1] = worktree;
    } else if (arg.startsWith('--worktree=')) {
      worktree = resolve(caller, arg.slice('--worktree='.length));
      out[i] = `--worktree=${worktree}`;
    }
    if (arg === '--body-file' && out[i + 1] !== undefined)
      out[i + 1] = resolve(caller, out[i + 1] as string);
    else if (arg.startsWith('--body-file='))
      out[i] =
        `--body-file=${resolve(caller, arg.slice('--body-file='.length))}`;
  }
  return { worktree, args: out };
}

/**
 * Starts `krn pr ship` as a session of its own, with stdout and stderr in the worktree log, so it outlives
 * the agent that started it. `argv` is the node argument list of the ship (entry script first).
 */
export function startDetachedShip(
  worktree: string,
  argv: readonly string[],
): { pid: number; log: string } {
  const running = liveShipPid(worktree);
  if (running !== undefined)
    throw new Error(
      `a ship of ${worktree} is already live (pid ${running}); wait for it or read ${join(worktree, shipLogPath)}`,
    );
  mkdirSync(join(worktree, '.krn', 'tmp'), { recursive: true });
  const log = join(worktree, shipLogPath);
  const out = openSync(log, 'w');
  try {
    const child = spawn(process.execPath, [...argv], {
      cwd: worktree,
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    if (child.pid === undefined)
      throw new Error('the detached ship did not start');
    markShipLive(worktree, child.pid);
    return { pid: child.pid, log };
  } finally {
    closeSync(out);
  }
}
