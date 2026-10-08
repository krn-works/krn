import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

import type { Job } from '../core/index.ts';

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.error || result.status !== 0)
    throw result.error ?? new Error(result.stderr || 'git command failed');
  return result.stdout;
}

function assertPathsInside(root: string, paths: string[]): void {
  for (const path of paths) {
    if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..'))
      throw new Error('refusing git paths outside the job worktree');
    const resolved = resolve(root, path);
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`))
      throw new Error('refusing git paths outside the job worktree');
  }
}

function statusPaths(output: string): string[] {
  const fields = output.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (const field of fields) paths.push(field.slice(3));
  return paths;
}

export function commitCheckpoint(job: Job, message: string): string {
  if (!message || message.length > 200 || /[\r\n]/.test(message))
    throw new Error('invalid checkpoint commit message');
  const root = realpathSync(job.worktree);
  if (realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim()) !== root)
    throw new Error('job worktree does not match the git repository root');
  const status = git(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--no-renames',
    '--untracked-files=all',
  ]);
  const paths = statusPaths(status);
  if (!paths.length)
    throw new Error('checkpoint refused: no changes to commit');
  assertPathsInside(root, paths);
  git(root, ['add', '--all', '--', '.']);
  const staged = git(root, ['diff', '--cached', '--name-only', '-z']);
  const stagedPaths = staged.split('\0').filter(Boolean);
  if (!stagedPaths.length)
    throw new Error('checkpoint refused: no changes to commit');
  assertPathsInside(root, stagedPaths);
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']).trim();
}
