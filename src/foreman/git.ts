// Foreman git commands are pinned to start-time repository anchors and inert hooks. ADR 0001.
import { spawnSync } from 'node:child_process';
import type { Job } from '../core/index.ts';
import { repoRecord } from './state.ts';

export function git(job: Job, args: string[]): string {
  const record = repoRecord(job);
  const result = spawnSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    {
      cwd: job.worktree,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_DIR: record.gitDir,
        GIT_WORK_TREE: record.gitWorkTree,
      },
    },
  );
  if (result.error || result.status !== 0)
    throw result.error ?? new Error(result.stderr || 'git command failed');
  return result.stdout;
}
