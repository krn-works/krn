import { spawnSync } from 'node:child_process';
import { WorkerError } from './state.ts';

export function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10000,
  });
  if (result.status !== 0)
    throw new WorkerError(65, 'worker git operation failed');
  return result.stdout;
}
