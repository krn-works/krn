import type { Job } from '../core/index.ts';
import { commitCheckpoint } from './commit.ts';
import type { Capsule, Deps } from './types.ts';

export function isCheckpointRefusal(error: unknown): error is Error {
  return (
    error instanceof Error && error.message.startsWith('checkpoint refused:')
  );
}

export async function finishCheckpoint(
  job: Job,
  capsule: Capsule,
  intent: string,
  d: Deps,
): Promise<{
  readonly capsule: Capsule;
  readonly sha: string;
  readonly done: boolean;
}> {
  const sessionId = capsule.sessionId;
  if (!sessionId) throw new Error('checkpoint has no bound session');
  const request = await d.trace.checkpointRequest(job, intent, sessionId);
  if (!request) throw new Error('checkpoint request is missing or stale');
  await d.relay.checkpoint(
    job,
    sessionId,
    request.message,
    request.next,
    request.decision,
  );
  await d.trace.checkpoint(
    job,
    intent,
    sessionId,
    request.message,
    request.next,
    request.decision,
  );
  const sha = commitCheckpoint(job, request.message, sessionId);
  await d.trace.commit(job, intent, sessionId, sha, request.message);
  const committed = await d.relay.recordCommit(
    job,
    sessionId,
    sha,
    request.message,
  );
  return { capsule: committed, sha, done: request.next === 'done' };
}
