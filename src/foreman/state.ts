// Foreman authority lives in the main checkout; worktree files are projections. ADR 0001.

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Job } from '../core/index.ts';

const recordSchema = z.object({
  repoRoot: z.string().min(1),
  gitDir: z.string().min(1),
  gitWorkTree: z.string().min(1),
  baseRef: z.string().min(1).optional(),
  baseSha: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/iu)
    .optional(),
});
type RepoRecord = z.infer<typeof recordSchema>;

export function repoRecord(job: Job): RepoRecord {
  const common = spawnSync(
    'git',
    [
      '-C',
      job.worktree,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ],
    { encoding: 'utf8' },
  );
  if (common.status !== 0)
    throw new Error(common.stderr || 'unable to locate main checkout');
  const gitRoot = dirname(resolve(common.stdout.trim()));
  const repoRoot = job.repoRoot ? realpathSync(job.repoRoot) : gitRoot;
  if (repoRoot !== gitRoot)
    throw new Error(
      'repo root does not match the worktree git common directory',
    );
  const path = join(repoRoot, '.krn', 'runs', 'foreman', job.id, 'repo.json');
  try {
    const record = recordSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (
      record.gitWorkTree !== resolve(job.worktree) ||
      (job.repoRoot && record.repoRoot !== resolve(job.repoRoot))
    )
      throw new Error('recorded repository anchors do not match the job');
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const get = (args: string[]) => {
    const result = spawnSync('git', ['-C', job.worktree, ...args], {
      encoding: 'utf8',
    });
    if (result.status !== 0)
      throw new Error(result.stderr || 'unable to locate repository');
    return result.stdout.trim();
  };
  return recordSchema.parse({
    repoRoot,
    gitDir: resolve(job.worktree, get(['rev-parse', '--absolute-git-dir'])),
    gitWorkTree: job.worktree,
  });
}

// start passes the merge-base of checkout HEAD and the selected ref,
// captured before worktree creation.
export function recordRepo(
  job: Job,
  root: string,
  baseRef?: string,
  baseSha?: string,
): RepoRecord {
  const repoRoot = realpathSync(resolve(root));
  const result = spawnSync(
    'git',
    ['-C', job.worktree, 'rev-parse', '--absolute-git-dir'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new Error(
      result.stderr || 'unable to record repository git directory',
    );
  const gitWorkTree = realpathSync(resolve(job.worktree));
  if (gitWorkTree !== resolve(job.worktree))
    throw new Error('worktree path is not canonical');
  if (baseSha !== undefined && !/^[0-9a-f]{40,64}$/iu.test(baseSha))
    throw new Error('base SHA must be 40 to 64 hexadecimal characters');
  let recordedBaseSha = baseSha;
  if (recordedBaseSha === undefined && baseRef !== undefined) {
    const base = spawnSync(
      'git',
      [
        '-C',
        job.worktree,
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${baseRef}^{commit}`,
      ],
      { encoding: 'utf8' },
    );
    if (base.status !== 0)
      throw new Error(`base ref "${baseRef}" does not resolve to a commit`);
    recordedBaseSha = base.stdout.trim();
  }
  const record = recordSchema.parse({
    repoRoot,
    gitDir: resolve(result.stdout.trim()),
    gitWorkTree,
    ...(baseRef === undefined ? {} : { baseRef }),
    ...(recordedBaseSha === undefined ? {} : { baseSha: recordedBaseSha }),
  });
  const directory = join(repoRoot, '.krn', 'runs', 'foreman', job.id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fd = openSync(join(directory, 'repo.json'), 'wx', 0o600);
  try {
    writeSync(fd, JSON.stringify(record));
  } finally {
    closeSync(fd);
  }
  return record;
}

export function stateDirectory(job: Job): string {
  return join(repoRecord(job).repoRoot, '.krn', 'runs', 'foreman', job.id);
}

export function ensureProjectionDirectory(job: Job): string {
  const root = resolve(job.worktree);
  if (realpathSync(root) !== root) throw new Error('unsafe worktree path');
  let current = root;
  for (const part of ['.krn', 'runs', 'delivery-loop', job.id]) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error('unsafe projection symlink');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(current, { mode: 0o700 });
    }
    if (
      realpathSync(current) !== current ||
      !current.startsWith(`${root}${sep}`)
    )
      throw new Error('unsafe projection path');
  }
  return current;
}
