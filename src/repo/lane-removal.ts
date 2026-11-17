import { spawnSync } from 'node:child_process';
import { readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';

/**
 * The pids of other processes whose working directory is `path` or lies under it, or undefined when
 * this host cannot say (no /proc). A lane session, its shell and its hooks run there: removing their
 * cwd makes every later spawn of that session fail, so a finished lane is removed only when this is
 * empty. The calling process itself never counts: a ship that runs inside its worktree may remove it.
 */
export function worktreeUsers(
  path: string,
  self = process.pid,
): number[] | undefined {
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return undefined;
  }
  // /proc holds resolved paths: a symlinked worktree path must be resolved too, or every user is missed.
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    /* A missing worktree has no users. */
  }
  const users: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    if (pid === self) continue;
    try {
      const cwd = readlinkSync(`/proc/${entry}/cwd`);
      if (cwd === real || cwd.startsWith(real + sep)) users.push(pid);
    } catch {
      /* Gone, or another user's process: it cannot run in our worktree. */
    }
  }
  return users;
}

export type LaneGit = (
  args: string[],
  cwd: string,
) => { code: number; stdout: string };

export const spawnGit: LaneGit = (args, cwd) => {
  const out = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { code: out.status ?? 70, stdout: out.stdout ?? '' };
};

export type LaneRemoval =
  | { removed: true }
  | { removed: false; reason: string };

/**
 * Removes a merged lane's worktree and branch from the main checkout: refused while the worktree holds
 * an uncommitted change or another process still works inside it (`users` returns pids). `users`
 * returning undefined (no /proc) refuses too: the caller then falls back to its own rule.
 */
export function removeFinishedLane(
  main: string,
  worktree: string,
  branch: string,
  options: {
    git?: LaneGit;
    users?: (path: string) => number[] | undefined;
  } = {},
): LaneRemoval {
  const git = options.git ?? spawnGit;
  const users = (options.users ?? worktreeUsers)(worktree);
  if (users === undefined)
    return { removed: false, reason: 'this host cannot list process cwds' };
  if (users.length > 0)
    return {
      removed: false,
      reason: `process ${users.slice(0, 3).join(', ')} still works inside it`,
    };
  const status = git(['status', '--porcelain'], worktree);
  if (status.code !== 0 || status.stdout.trim() !== '')
    return { removed: false, reason: 'it holds uncommitted changes' };
  if (git(['worktree', 'remove', '--force', worktree], main).code !== 0)
    return { removed: false, reason: 'git worktree remove failed' };
  if (
    git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], main)
      .code === 0
  )
    git(['branch', '-D', branch], main);
  return { removed: true };
}
