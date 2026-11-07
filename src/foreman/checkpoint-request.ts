// The worker can request a checkpoint but cannot write foreman state. ADR 0001.
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Job } from '../core/index.ts';

const requestSchema = z.object({
  intent: z.string().regex(/^intent:\d+$/),
  sessionId: z.string().min(1).max(128),
  message: z.string().min(1).max(200),
  next: z.string().min(1).max(200),
  decision: z.string().max(500).optional(),
});
type CheckpointRequest = z.infer<typeof requestSchema>;

function mailbox(job: Job, sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId))
    throw new Error('invalid checkpoint session id');
  const directory = join(job.worktree, '.krn', 'runs', 'foreman', 'checkpoint');
  return join(directory, `${sessionId}.json`);
}

export function writeCheckpointRequest(job: Job, input: unknown): void {
  const request = requestSchema.parse(input);
  const path = mailbox(job, request.sessionId);
  const directory = join(job.worktree, '.krn', 'runs', 'foreman', 'checkpoint');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== directory)
    throw new Error('unsafe checkpoint mailbox directory');
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const prior = readCheckpointRequest(job, request.sessionId);
    if (JSON.stringify(prior) === JSON.stringify(request)) return;
    throw new Error('checkpoint request conflicts with existing mailbox entry');
  }
  try {
    writeSync(fd, JSON.stringify(request));
  } finally {
    closeSync(fd);
  }
}

export function readCheckpointRequest(
  job: Job,
  sessionId: string,
): CheckpointRequest | null {
  const path = mailbox(job, sessionId);
  try {
    if (
      realpathSync(
        join(job.worktree, '.krn', 'runs', 'foreman', 'checkpoint'),
      ) !== join(job.worktree, '.krn', 'runs', 'foreman', 'checkpoint')
    )
      return null;
    if (!lstatSync(path).isFile()) return null;
    return requestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}
