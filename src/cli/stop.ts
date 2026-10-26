import { resolve } from 'node:path';
import type { Job } from '../core/index.ts';
import { operatorStop } from '../trace/index.ts';

function value(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const result = index < 0 ? undefined : args[index + 1];
  if (!result || result.startsWith('--')) throw new Error(`missing ${flag}`);
  return result;
}

export async function stopCommand(args: string[]): Promise<void> {
  const job: Job = {
    id: value(args, '--job'),
    issue: value(args, '--issue'),
    worktree: resolve(value(args, '--worktree')),
    ...(args.includes('--repo-root')
      ? { repoRoot: resolve(value(args, '--repo-root')) }
      : {}),
  };
  await operatorStop(job, process.env.USER ?? 'local operator');
}
