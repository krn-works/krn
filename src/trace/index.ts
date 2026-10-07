// Trace is append-only so a resumed worker can distinguish durable checkpoints. ADR 0001.

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import type { Job } from '../core/index.ts';
import type { SessionEnd } from '../foreman/types.ts';

type Event = {
  readonly key: string;
  readonly kind: string;
  readonly at: string;
  readonly data: Record<string, unknown>;
};

function file(job: Job): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(job.id) || job.id === '..')
    throw new Error('invalid trace job id');
  return join(job.worktree, '.krn', 'runs', 'foreman', `${job.id}.jsonl`);
}

function events(job: Job): Event[] {
  const path = file(job);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (
        !value ||
        typeof value !== 'object' ||
        !('key' in value) ||
        !('kind' in value) ||
        !('data' in value)
      )
        throw new Error('malformed trace event');
      return value as Event;
    });
}

function append(
  job: Job,
  key: string,
  kind: string,
  data: Record<string, unknown>,
): void {
  const path = file(job);
  mkdirSync(join(job.worktree, '.krn', 'runs', 'foreman'), {
    recursive: true,
    mode: 0o700,
  });
  const prior = events(job).find((event) => event.key === key);
  if (prior) return;
  const fd = openSync(path, 'a', 0o600);
  try {
    writeSync(
      fd,
      `${JSON.stringify({ id: randomUUID(), key, kind, at: new Date().toISOString(), data })}\n`,
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export async function intent(job: Job, epoch: number): Promise<string> {
  const key = `intent:${epoch}`;
  append(job, key, 'intent', { jobId: job.id, epoch });
  return key;
}

export async function started(
  job: Job,
  intentId: string,
  sessionId: string,
): Promise<boolean> {
  // Session starts are unique by opaque host identity, while the intent key fences retries.
  const prior = events(job).find(
    (event) => event.key === `${intentId}:session`,
  );
  if (prior) return prior.data.sessionId === sessionId;
  append(job, `${intentId}:session`, 'session_started', {
    intent: intentId,
    sessionId,
  });
  return true;
}

export async function checkpoint(
  job: Job,
  intentId: string,
  sessionId: string,
): Promise<void> {
  const started = events(job).find(
    (event) => event.key === `${intentId}:session`,
  );
  if (started?.data.sessionId !== sessionId)
    throw new Error('checkpoint does not match a started session');
  append(job, `${intentId}:checkpoint:${sessionId}`, 'checkpoint', {
    intent: intentId,
    sessionId,
  });
}

export async function hasCheckpoint(
  job: Job,
  intentId: string,
  sessionId: string,
): Promise<boolean> {
  return events(job).some(
    (event) => event.key === `${intentId}:checkpoint:${sessionId}`,
  );
}

export async function log(
  job: Job,
  intentId: string,
  sessionId: string,
  event: 'session_ended',
  end: SessionEnd,
): Promise<void> {
  append(job, `${intentId}:ended:${sessionId}`, event, {
    intent: intentId,
    sessionId,
    end,
  });
}

export async function failure(
  job: Job,
  intentId: string,
  error: unknown,
): Promise<void> {
  append(job, `${intentId}:failure`, 'failure', { message: String(error) });
}

export async function operatorStart(job: Job, operator: string): Promise<void> {
  append(job, `operator-start:${randomUUID()}`, 'operator_start', { operator });
}

export async function operatorStop(job: Job, operator: string): Promise<void> {
  append(job, `operator-stop:${randomUUID()}`, 'operator_stop', { operator });
}
