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
import { readCheckpointRequest } from '../foreman/checkpoint-request.ts';
import { stateDirectory } from '../foreman/state.ts';
import type { SessionEnd } from '../foreman/types.ts';
import type { SubmissionReceipt } from '../ledger/index.ts';
import type { VerdictEvent } from '../verdict/index.ts';

type Event = {
  readonly key: string;
  readonly kind: string;
  readonly at: string;
  readonly data: Record<string, unknown>;
};

function file(job: Job): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(job.id) || job.id === '..')
    throw new Error('invalid trace job id');
  return join(stateDirectory(job), 'trace.jsonl');
}

function events(job: Job): Event[] {
  const path = file(job);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const value: unknown = JSON.parse(line);
        return z
          .object({
            key: z.string(),
            kind: z.string(),
            at: z.string(),
            data: z.record(z.string(), z.unknown()),
          })
          .parse(value);
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function append(
  job: Job,
  key: string,
  kind: string,
  data: Record<string, unknown>,
): boolean {
  const path = file(job);
  mkdirSync(stateDirectory(job), {
    recursive: true,
    mode: 0o700,
  });
  const prior = events(job).find((event) => event.key === key);
  if (prior) return false;
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
  return true;
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
  isolation?: 'pid_namespace' | 'systemd_scope',
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
  _decision?: string,
): Promise<void> {
  const request = await checkpointRequest(job, intentId, sessionId);
  if (!request || request.message !== message || request.next !== next)
    throw new Error('checkpoint request is missing or stale');
  append(job, `${intentId}:checkpoint:${sessionId}`, 'checkpoint', {
    intent: intentId,
    sessionId,
    message,
    next,
    ...(request.decision === undefined ? {} : { decision: request.decision }),
  });
}

export async function checkpointRequest(
  job: Job,
  intentId: string,
  sessionId: string,
): Promise<{
  readonly message: string;
  readonly next: string;
  readonly decision?: string;
} | null> {
  const trace = events(job);
  const started = trace.find((event) => event.key === `${intentId}:session`);
  if (started?.data.sessionId !== sessionId) return null;
  const request = readCheckpointRequest(job, sessionId);
  return request?.intent === intentId && request.sessionId === sessionId
    ? {
        message: request.message,
        next: request.next,
        ...(request.decision === undefined
          ? {}
          : { decision: request.decision }),
      }
    : null;
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
  return (await checkpointRequest(job, intentId, sessionId)) !== null;
}

export async function sessionEnd(
  job: Job,
  sessionId: string,
): Promise<SessionEnd | null> {
  const trace = events(job);
  const value = trace.find(
    (event) =>
      event.kind === 'session_ended' && event.data.sessionId === sessionId,
  )?.data.end;
  const parsed = z
    .object({ reasonKind: z.string(), claimsDone: z.boolean() })
    .safeParse(value);
  if (!parsed.success) return null;
  const completed = trace.some(
    (event) =>
      event.kind === 'checkpoint' &&
      event.data.sessionId === sessionId &&
      event.data.next === 'done',
  );
  return { ...parsed.data, claimsDone: completed };
}

export async function sessionIsolation(
  job: Job,
  sessionId: string,
): Promise<'pid_namespace' | 'systemd_scope' | null> {
  const started = events(job).find(
    (event) =>
      event.kind === 'session_started' && event.data.sessionId === sessionId,
  );
  return started?.data.isolation === 'systemd_scope' ||
    started?.data.isolation === 'pid_namespace'
    ? started.data.isolation
    : null;
}

export async function sessionLost(
  job: Job,
  sessionId: string,
  dirtyPaths: readonly string[],
): Promise<void> {
  append(job, `session-lost:${sessionId}`, 'session_lost', {
    sessionId,
    dirtyPaths,
  });
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

export async function verdict(job: Job, event: VerdictEvent): Promise<void> {
  append(job, `verdict:${event.sha}`, 'verdict', {
    sha: event.sha,
    checks: event.checks.map(({ id, exitCode, durationMs, sha256 }) => ({
      id,
      exitCode,
      durationMs,
      sha256,
    })),
  });
}

export async function hasVerdict(job: Job, sha: string): Promise<boolean> {
  return events(job).some(
    (event) => event.kind === 'verdict' && event.data.sha === sha,
  );
}

export async function submitIntent(
  job: Job,
  sha: string,
  contractRevision: string,
): Promise<boolean> {
  const priorForSha = events(job).some(
    (event) => event.kind === 'submit_intent' && event.data.sha === sha,
  );
  const key = `submit-intent:${sha}:${contractRevision}`;
  const created = append(job, key, 'submit_intent', { sha, contractRevision });
  return priorForSha || !created;
}

export async function submittedFor(
  job: Job,
  sha: string,
): Promise<SubmissionReceipt | null> {
  const event = events(job).find(
    (candidate) => candidate.kind === 'submitted' && candidate.data.sha === sha,
  );
  if (!event) return null;
  const parsed = z
    .object({
      issueId: z.string().min(1),
      status: z.string().min(1),
      updatedAt: z.string().min(1),
    })
    .safeParse(event.data.receipt);
  return parsed.success ? parsed.data : null;
}

export function submitted(
  job: Job,
  sha: string,
  receipt: SubmissionReceipt,
): void {
  append(job, `submitted:${sha}`, 'submitted', { sha, receipt });
}

export async function stopped(job: Job, signal: string): Promise<void> {
  append(job, `stopped:${randomUUID()}`, 'stopped', { signal });
}

export async function teardownUnconfirmed(
  job: Job,
  detail: string,
): Promise<void> {
  append(job, `teardown-unconfirmed:${randomUUID()}`, 'teardown_unconfirmed', {
    detail: detail.slice(0, 1000),
  });
}

export function paperclipUpdateStarted(
  job: Job,
  sha: string,
  kind: 'review' | 'conflict_comment',
): void {
  append(
    job,
    `paperclip-update-started:${randomUUID()}`,
    'paperclip_update_started',
    {
      sha,
      kind,
    },
  );
}

export async function readyForReview(job: Job, sha: string): Promise<void> {
  append(job, `ready-for-review:${sha}`, 'ready_for_review', { sha });
}

export async function operatorStart(job: Job, operator: string): Promise<void> {
  append(job, `operator-start:${randomUUID()}`, 'operator_start', { operator });
}

export async function operatorStop(job: Job, operator: string): Promise<void> {
  append(job, `operator-stop:${randomUUID()}`, 'operator_stop', { operator });
}
