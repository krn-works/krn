// Start creates the isolated job worktree; checkpoint persists before stopping its worker. ADR 0001.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

import type { Job } from '../core/index.ts';
import { checkpoint as saveCheckpoint } from '../relay/index.ts';
import { checkpoint, operatorStart, operatorStop } from '../trace/index.ts';

function value(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const result = index < 0 ? undefined : args[index + 1];
  if (!result || result.startsWith('--')) throw new Error(`missing ${flag}`);
  return result;
}

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(result.stderr || 'git command failed');
  return result.stdout.trim();
}

function assertWorktreeParentInside(root: string, parent: string): void {
  const realRoot = realpathSync(root);
  const realParent = realpathSync(parent);
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`))
    throw new Error(
      'job worktree parent must resolve inside the target repository',
    );
}

async function start(args: string[]): Promise<void> {
  const id = value(args, '--job');
  const issue = value(args, '--issue');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id === '..')
    throw new Error('invalid job id');
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  const worktree = resolve(root, '.krn', 'worktrees', id);
  if (existsSync(dirname(worktree)))
    assertWorktreeParentInside(root, dirname(worktree));
  const ignored = spawnSync('git', [
    '-C',
    root,
    'check-ignore',
    '-q',
    `.krn/worktrees/${id}`,
  ]);
  if (ignored.status !== 0)
    throw new Error(
      `target repository must ignore .krn/worktrees/${id} before starting a job`,
    );
  mkdirSync(dirname(worktree), { recursive: true });
  assertWorktreeParentInside(root, dirname(worktree));
  const result = spawnSync(
    'git',
    ['-C', root, 'worktree', 'add', '-b', `krn/${id}`, worktree, 'HEAD'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || 'unable to create job worktree');
  try {
    assertWorktreeParentInside(root, dirname(worktree));
  } catch (error) {
    const rollback = spawnSync(
      'git',
      ['-C', root, 'worktree', 'remove', '--force', worktree],
      { encoding: 'utf8' },
    );
    if (rollback.status !== 0)
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; unable to roll back escaped worktree: ${rollback.stderr || 'git command failed'}`,
      );
    throw error;
  }
  const job: Job = { id, issue, worktree };
  await operatorStart(job, process.env.USER ?? 'local operator');
  process.stdout.write(`${JSON.stringify(job)}\n`);
}

async function stop(
  args: string[],
  kind: 'checkpoint' | 'stop',
): Promise<void> {
  const job: Job = {
    id: value(args, '--job'),
    issue: value(args, '--issue'),
    worktree: resolve(value(args, '--worktree')),
  };
  if (kind === 'checkpoint') {
    const next = value(args, '--next');
    if (next.length > 200 || /[\r\n]/.test(next))
      throw new Error('--next must be a single line of at most 200 characters');
    const decision = args.includes('--decision')
      ? value(args, '--decision')
      : undefined;
    if (decision && (decision.length > 500 || /[\r\n]/.test(decision)))
      throw new Error(
        '--decision must be a single line of at most 500 characters',
      );
    const status = git(job.worktree, [
      'status',
      '--porcelain',
      '--untracked-files=normal',
    ]);
    if (status) throw new Error('checkpoint requires a clean working tree');
    const session = value(args, '--session');
    await saveCheckpoint(job, session, next, decision);
    await checkpoint(job, value(args, '--intent'), session, next, decision);
  } else await operatorStop(job, process.env.USER ?? 'local operator');
}

export async function dispatch(args: string[]): Promise<boolean> {
  const [command, ...options] = args;
  if (command === 'start') await start(options);
  else if (command === 'checkpoint' || command === 'stop')
    await stop(options, command);
  else return false;
  return true;
}
