import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { Job } from '../core/index.ts';
import { recordRepo } from '../foreman/state.ts';
import { operatorStart } from '../trace/index.ts';
import { gitOutput, resolveBaseRef } from './index.ts';
import { CliUsageError } from './usage-error.ts';

function value(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const result = index < 0 ? undefined : args[index + 1];
  if (!result || result.startsWith('--'))
    throw new CliUsageError(`missing ${flag}`);
  return result;
}

function assertWorktreeParentInside(root: string, parent: string): void {
  const realRoot = realpathSync(root);
  const realParent = realpathSync(parent);
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`))
    throw new Error(
      'job worktree parent must resolve inside the target repository',
    );
}

export async function startCommand(args: string[]): Promise<void> {
  const id = value(args, '--job');
  const issue = value(args, '--issue');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id === '..')
    throw new CliUsageError('invalid job id');
  const root = gitOutput(process.cwd(), ['rev-parse', '--show-toplevel']);
  const baseRef = resolveBaseRef(
    root,
    args.includes('--base') ? value(args, '--base') : undefined,
  );
  const refSha = gitOutput(root, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${baseRef}^{commit}`,
  ]);
  const checkoutHead = gitOutput(root, ['rev-parse', 'HEAD']);
  const baseResult = spawnSync(
    'git',
    ['-C', root, 'merge-base', checkoutHead, refSha],
    { encoding: 'utf8' },
  );
  if (baseResult.status === 1)
    throw new CliUsageError(
      `base ref "${baseRef}" has no common ancestor with checkout HEAD`,
    );
  if (baseResult.status !== 0)
    throw new Error(baseResult.stderr || 'unable to compute base merge-base');
  const baseSha = baseResult.stdout.trim();
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
    throw new CliUsageError(
      `target repository must ignore .krn/worktrees/${id} before starting a job`,
    );
  mkdirSync(dirname(worktree), { recursive: true });
  assertWorktreeParentInside(root, dirname(worktree));
  const result = spawnSync(
    'git',
    ['-C', root, 'worktree', 'add', '-b', `krn/${id}`, worktree, checkoutHead],
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
  const job: Job = { id, issue, worktree, repoRoot: root };
  recordRepo(job, root, baseRef, baseSha);
  await operatorStart(job, process.env.USER ?? 'local operator');
  process.stdout.write(`${JSON.stringify(job)}\n`);
}
