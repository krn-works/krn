import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { lanePacket, packetBrief } from '../brain/worker-packet.ts';
import { claimTask, mainCheckoutRoot } from '../task/claims.ts';
import { isTaskId } from '../task/record.ts';
import { repositoryRoot } from '../task/store.ts';
import { flagValue } from './flag-value.ts';
import { CliUsageError } from './usage-error.ts';

export const laneUsage = [
  'krn lane start SLUG [--task ID] [--actor NAME] [--reason TEXT] [--root DIR]  fetch origin main, create branch SLUG in .krn/worktrees/SLUG, claim the task; prints the path and branch',
  'krn lane brief [--file PATH] [--task ID] [--as-of YYYY-MM-DD] [--root DIR]  print the lane brief (file, else stdin) behind the FR-40 brain packet of the repository records',
].join('\n');

/** The lane brief with the FR-40 carrier prefix (D0, t-5983e6g): the measured arm-B prompt. */
export function laneBriefText(
  repo: string,
  brief: string,
  asOf: string,
  task = 'lane-brief',
): string {
  return packetBrief(lanePacket(repo, brief, asOf, task), brief);
}

function briefCommand(rest: string[]): void {
  let file: string | undefined;
  let task: string | undefined;
  let asOf = new Date().toISOString().slice(0, 10);
  let root: string | undefined;
  const value = (index: number, name: string) =>
    flagValue(rest, index, () => new CliUsageError(`${name} requires a value`));
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === '--file') file = value(index++, arg);
    else if (arg === '--task') task = value(index++, arg);
    else if (arg === '--as-of') asOf = value(index++, arg);
    else if (arg === '--root') root = value(index++, arg);
    else throw new CliUsageError(laneUsage);
  }
  if (task !== undefined && !isTaskId(task))
    throw new CliUsageError(`not a task id: ${task}`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(asOf))
    throw new CliUsageError(`--as-of must be YYYY-MM-DD: ${asOf}`);
  const brief = readFileSync(file ?? 0, 'utf8');
  if (brief.trim() === '') throw new CliUsageError('lane brief is empty');
  const repo = repositoryRoot(root ?? process.cwd());
  process.stdout.write(laneBriefText(repo, brief, asOf, task));
}

// Host budget: refuse below KRN_LANE_MIN_FREE_GB free (default 5) on the
// repository or the lane temp dir, and at KRN_LANE_MAX_LIVE worktrees (default 8).
function limit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 && process.env[name] !== ''
    ? value
    : fallback;
}

function freeGb(dir: string): number | undefined {
  try {
    const stats = statfsSync(dir);
    return (stats.bavail * stats.bsize) / 1024 ** 3;
  } catch {
    return undefined;
  }
}

export function checkLaneBudget(main: string): void {
  const minFree = limit('KRN_LANE_MIN_FREE_GB', 5);
  for (const dir of [
    main,
    process.env.KRN_LANE_TMP ?? join(sep, 'mnt', 'storage', 'tmp'),
  ]) {
    const free = freeGb(dir);
    if (free !== undefined && free < minFree)
      throw new CliUsageError(
        `lane budget: only ${free.toFixed(1)} GB free under ${dir} (minimum ${minFree} GB, KRN_LANE_MIN_FREE_GB); free disk before starting a lane`,
      );
  }
  const maxLive = limit('KRN_LANE_MAX_LIVE', 8);
  const dir = join(main, '.krn', 'worktrees');
  const live = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
        .length
    : 0;
  if (live >= maxLive)
    throw new CliUsageError(
      `lane budget: ${live} live lane worktrees in ${dir} (maximum ${maxLive}, KRN_LANE_MAX_LIVE); ship or remove a lane first`,
    );
}

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
  if (verb === 'brief') return briefCommand(rest);
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

  checkLaneBudget(main);
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
