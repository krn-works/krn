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
import { z } from 'zod';
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
  pgid?: number,
  isolation?: 'pid_namespace' | 'proc_tree_fallback',
): Promise<boolean> {
  // Session starts are unique by opaque host identity, while the intent key fences retries.
  const prior = events(job).find(
    (event) => event.key === `${intentId}:session`,
  );
  if (prior) return prior.data.sessionId === sessionId;
  append(job, `${intentId}:session`, 'session_started', {
    intent: intentId,
    sessionId,
    ...(pgid === undefined ? {} : { pgid }),
    sandbox: 'workspace-write',
    isolation: isolation ?? 'unknown',
  });
  return true;
}

export async function checkpoint(
  job: Job,
  intentId: string,
  sessionId: string,
  message: string,
  next: string,
  decision?: string,
): Promise<void> {
  append(job, `${intentId}:checkpoint:${sessionId}`, 'checkpoint', {
    intent: intentId,
    sessionId,
    message,
    next,
    ...(decision === undefined ? {} : { decision }),
  });
}

export async function checkpointRequest(
  job: Job,
  intentId: string,
  sessionId: string,
): Promise<{ readonly message: string; readonly next: string } | null> {
  const trace = events(job);
  const started = trace.find((event) => event.key === `${intentId}:session`);
  if (started?.data.sessionId !== sessionId) return null;
  const value = trace.find(
    (event) => event.key === `${intentId}:checkpoint:${sessionId}`,
  );
  if (value?.data.sessionId !== sessionId) return null;
  const parsed = z
    .object({ message: z.string().min(1), next: z.string().min(1) })
    .safeParse(value.data);
  return parsed.success ? parsed.data : null;
}

export async function commit(
  job: Job,
  intentId: string,
  sessionId: string,
  sha: string,
  message: string,
): Promise<void> {
  if (!/^[a-f0-9]{40,64}$/i.test(sha))
    throw new Error('commit SHA is malformed');
  const request = await checkpointRequest(job, intentId, sessionId);
  if (!request || request.message !== message)
    throw new Error('commit does not match the bound checkpoint request');
  const key = `${intentId}:commit:${sessionId}`;
  const prior = events(job).find((event) => event.key === key);
  if (prior) {
    if (prior.data.sha !== sha || prior.data.message !== message)
      throw new Error('commit conflicts with the recorded session commit');
    return;
  }
  append(job, key, 'commit', {
    intent: intentId,
    sessionId,
    sha,
    message,
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

export async function sessionEnd(
  job: Job,
  sessionId: string,
): Promise<SessionEnd | null> {
  const value = events(job).find(
    (event) =>
      event.kind === 'session_ended' && event.data.sessionId === sessionId,
  )?.data.end;
  const parsed = z
    .object({ reasonKind: z.string(), claimsDone: z.boolean() })
    .safeParse(value);
  return parsed.success ? parsed.data : null;
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
    end: {
      exitCode: end.exitCode,
      signal: end.signal,
      threadId: end.threadId,
      usage: end.usage,
      reasonKind: end.reasonKind,
      reasonSha256: end.reasonSha256,
      reasonLength: end.reasonLength,
      claimsDone: end.claimsDone,
    },
  });
}

export async function failure(
  job: Job,
  intentId: string,
  error: unknown,
): Promise<void> {
  append(job, `${intentId}:failure`, 'failure', {
    errorType: error instanceof Error ? error.name : typeof error,
  });
}

export async function operatorStart(job: Job, operator: string): Promise<void> {
  append(job, `operator-start:${randomUUID()}`, 'operator_start', { operator });
}

export async function operatorStop(job: Job, operator: string): Promise<void> {
  append(job, `operator-stop:${randomUUID()}`, 'operator_stop', { operator });
}
