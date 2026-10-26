import { resolve } from 'node:path';
import { ZodError } from 'zod';
import type { Job } from '../core/index.ts';
import { writeCheckpointRequest } from '../foreman/checkpoint-request.ts';
import { CliUsageError } from './usage-error.ts';

function value(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const result = index < 0 ? undefined : args[index + 1];
  if (!result || result.startsWith('--'))
    throw new CliUsageError(`missing ${flag}`);
  return result;
}

export function checkpointCommand(args: string[]): void {
  const job: Job = {
    id: value(args, '--job'),
    issue: value(args, '--issue'),
    worktree: resolve(value(args, '--worktree')),
    ...(args.includes('--repo-root')
      ? { repoRoot: resolve(value(args, '--repo-root')) }
      : {}),
  };
  const message = value(args, '--message');
  if (message.length > 200 || /[\r\n]/.test(message))
    throw new CliUsageError(
      '--message must be a single line of at most 200 characters',
    );
  const next = value(args, '--next');
  if (next.length > 200 || /[\r\n]/.test(next))
    throw new CliUsageError(
      '--next must be a single line of at most 200 characters',
    );
  const decision = args.includes('--decision')
    ? value(args, '--decision')
    : undefined;
  if (decision && (decision.length > 500 || /[\r\n]/.test(decision)))
    throw new CliUsageError(
      '--decision must be a single line of at most 500 characters',
    );
  const session = value(args, '--session');
  try {
    writeCheckpointRequest(job, {
      intent: value(args, '--intent'),
      sessionId: session,
      message,
      next,
      decision,
    });
  } catch (error) {
    if (error instanceof ZodError) throw new CliUsageError(error.message);
    throw error;
  }
}
