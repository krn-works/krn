import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { claimTask, mainCheckoutRoot } from '../task/claims.ts';
import { isTaskId } from '../task/record.ts';
import { repositoryRoot } from '../task/store.ts';
import { flagValue } from './flag-value.ts';
import { CliUsageError } from './usage-error.ts';

export const laneUsage =
  'krn lane start SLUG [--task ID] [--actor NAME] [--reason TEXT] [--root DIR]  fetch origin main, create branch SLUG in .krn/worktrees/SLUG, claim the task; prints the path and branch';

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0)
    throw new CliUsageError(
      `git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout.trim();
}

function gitOk(root: string, args: string[]): boolean {
  return spawnSync('git', ['-C', root, ...args]).status === 0;
}

// A task created but not yet committed exists only in the invoking checkout;
// the new worktree is cut from origin/main, so the record moves with the lane.
function untrackedTaskRecord(origin: string, id: string): string | undefined {
  const file = join(origin, 'tasks', `${id}.json`);
  if (!existsSync(file)) return undefined;
  if (gitOk(origin, ['ls-files', '--error-unmatch', `tasks/${id}.json`])) {
    if (gitOk(origin, ['cat-file', '-e', `origin/main:tasks/${id}.json`]))
      return undefined;
    throw new CliUsageError(
      `tasks/${id}.json is tracked in ${origin} but not on origin/main; commit and push it first`,
    );
  }
  return file;
}

function carryTaskRecord(file: string, worktree: string, id: string): void {
  const target = join(worktree, 'tasks', `${id}.json`);
  if (existsSync(target)) return;
  copyFileSync(file, target);
  rmSync(file);
}

export async function laneCommand(args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (verb !== 'start') throw new CliUsageError(laneUsage);
  let slug: string | undefined;
  let task: string | undefined;
  let actor = 'lead';
  let reason: string | undefined;
  let root: string | undefined;
  const value = (index: number, name: string) =>
    flagValue(rest, index, () => new CliUsageError(`${name} requires a value`));
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === '--task') task = value(index++, arg);
    else if (arg === '--actor') actor = value(index++, arg);
    else if (arg === '--reason') reason = value(index++, arg);
    else if (arg === '--root') root = value(index++, arg);
    else if (arg.startsWith('--') || slug !== undefined)
      throw new CliUsageError(laneUsage);
    else slug = arg;
  }
  if (slug === undefined || !/^[a-z0-9][a-z0-9._-]*$/u.test(slug))
    throw new CliUsageError(
      `lane slug must be lowercase letters, digits, ".", "_" or "-"\n${laneUsage}`,
    );
  if (task !== undefined && !isTaskId(task))
    throw new CliUsageError(`not a task id: ${task}`);

  const origin = repositoryRoot(root ?? process.cwd());
  const main = mainCheckoutRoot(origin);
  const path = join(main, '.krn', 'worktrees', slug);
  if (existsSync(path))
    throw new CliUsageError(`lane ${slug} already exists at ${path}`);
  if (gitOk(main, ['show-ref', '--verify', '--quiet', `refs/heads/${slug}`]))
    throw new CliUsageError(`branch ${slug} already exists`);

  git(main, ['fetch', '-q', 'origin', 'main']);
  const carried =
    task === undefined ? undefined : untrackedTaskRecord(origin, task);
  git(main, ['worktree', 'add', '-q', '-b', slug, path, 'origin/main']);
  if (task !== undefined) {
    try {
      if (carried !== undefined) carryTaskRecord(carried, path, task);
      await claimTask(main, task, {
        actor,
        worktree: path,
        reason: reason ?? `lane ${slug}`,
      });
    } catch (error) {
      git(main, ['worktree', 'remove', '--force', path]);
      git(main, ['branch', '-D', slug]);
      throw error;
    }
  }
  process.stdout.write(`${realpathSync(path)}\n${slug}\n`);
}
