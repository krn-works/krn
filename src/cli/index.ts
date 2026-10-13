// Start creates the isolated job worktree; checkpoint persists before stopping its worker. ADR 0001.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

import type { Job } from '../core/index.ts';
import { reviewCommand } from '../flow/cli.ts';
import { writeCheckpointRequest } from '../foreman/checkpoint-request.ts';
import { recordRepo } from '../foreman/state.ts';
import {
  leadIntervention,
  operatorStart,
  operatorStop,
} from '../trace/index.ts';

function value(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const result = index < 0 ? undefined : args[index + 1];
  if (!result || result.startsWith('--')) throw new Error(`missing ${flag}`);
  return result;
}

function readNoteStdin(): string {
  const maximumBytes = 8192;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes < maximumBytes) {
    const chunk = Buffer.alloc(Math.min(1024, maximumBytes - totalBytes));
    const bytesRead = readSync(0, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  if (totalBytes === maximumBytes) {
    const overflow = Buffer.alloc(1);
    if (readSync(0, overflow, 0, 1, null) > 0)
      throw new Error('note text exceeds 8192 bytes');
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(result.stderr || 'git command failed');
  return result.stdout.trim();
}

function resolvesToCommit(root: string, ref: string): boolean {
  return (
    spawnSync(
      'git',
      [
        '-C',
        root,
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${ref}^{commit}`,
      ],
      { encoding: 'utf8' },
    ).status === 0
  );
}

export function resolveBaseRef(root: string, requested?: string): string {
  const remoteHead = spawnSync(
    'git',
    [
      '-C',
      root,
      'symbolic-ref',
      '--quiet',
      '--short',
      'refs/remotes/origin/HEAD',
    ],
    { encoding: 'utf8' },
  );
  const currentBranch = spawnSync(
    'git',
    ['-C', root, 'branch', '--show-current'],
    { encoding: 'utf8' },
  );
  if (requested) {
    if (!resolvesToCommit(root, requested))
      throw new Error(`base ref "${requested}" does not resolve to a commit`);
    return requested;
  }
  if (remoteHead.status === 0) {
    const remoteRef = remoteHead.stdout.trim();
    const localRef = remoteRef.replace(/^origin\//u, '');
    if (resolvesToCommit(root, localRef)) return localRef;
    if (remoteRef !== localRef && resolvesToCommit(root, remoteRef))
      return remoteRef;
    throw new Error(`base ref "${localRef}" does not resolve to a commit`);
  }
  const branch = currentBranch.stdout.trim();
  if (currentBranch.status === 0 && branch) {
    if (!resolvesToCommit(root, branch))
      throw new Error(`base ref "${branch}" does not resolve to a commit`);
    return branch;
  }
  throw new Error('unable to resolve a base ref; specify one with --base');
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
  const baseRef = resolveBaseRef(
    root,
    args.includes('--base') ? value(args, '--base') : undefined,
  );
  const refSha = git(root, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${baseRef}^{commit}`,
  ]);
  const checkoutHead = git(root, ['rev-parse', 'HEAD']);
  const baseResult = spawnSync(
    'git',
    ['-C', root, 'merge-base', checkoutHead, refSha],
    { encoding: 'utf8' },
  );
  if (baseResult.status === 1)
    throw new Error(
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
    throw new Error(
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

async function stop(
  args: string[],
  kind: 'checkpoint' | 'stop',
): Promise<void> {
  const job: Job = {
    id: value(args, '--job'),
    issue: value(args, '--issue'),
    worktree: resolve(value(args, '--worktree')),
    ...(args.includes('--repo-root')
      ? { repoRoot: resolve(value(args, '--repo-root')) }
      : {}),
  };
  if (kind === 'checkpoint') {
    const message = value(args, '--message');
    if (message.length > 200 || /[\r\n]/.test(message))
      throw new Error(
        '--message must be a single line of at most 200 characters',
      );
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
    const session = value(args, '--session');
    writeCheckpointRequest(job, {
      intent: value(args, '--intent'),
      sessionId: session,
      message,
      next,
      decision,
    });
  } else await operatorStop(job, process.env.USER ?? 'local operator');
}

async function note(args: string[]): Promise<void> {
  const text = (
    args.includes('--text') ? value(args, '--text') : readNoteStdin()
  ).trim();
  const cliKind = value(args, '--kind');
  if (cliKind !== 'intervention' && cliKind !== 'reconstruction')
    throw new Error('--kind must be intervention or reconstruction');
  const job: Job = {
    id: value(args, '--job'),
    issue: value(args, '--issue'),
    worktree: resolve(value(args, '--worktree')),
    ...(args.includes('--repo-root')
      ? { repoRoot: resolve(value(args, '--repo-root')) }
      : {}),
  };
  await leadIntervention(
    job,
    cliKind === 'intervention' ? 'intervention' : 'reconstruction_prompt',
    text,
  );
}

export async function dispatch(args: string[]): Promise<boolean> {
  const [command, ...options] = args;
  if (command === 'start') await start(options);
  else if (command === 'checkpoint' || command === 'stop')
    await stop(options, command);
  else if (command === 'note') await note(options);
  else if (command === 'review') await reviewCommand(options);
  else return false;
  return true;
}
