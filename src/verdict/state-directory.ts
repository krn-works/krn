// Review diagnostics live in the main checkout under .krn/runs/foreman/<job>.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

export function stateDirectory(job: Job): string {
  return join(repoRecord(job).repoRoot, '.krn', 'runs', 'foreman', job.id);
}
