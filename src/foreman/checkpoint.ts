import type { Job } from '../core/index.ts';
import { commitCheckpoint } from './commit.ts';
import type { Capsule, Contract, Deps, Outcome } from './types.ts';
import { verifyCheckpoint } from './verdict.ts';

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

export async function checkpointStep(
  job: Job,
  capsule: Capsule,
  intent: string,
  contract: Contract,
  repairs: number,
  d: Deps,
): Promise<
  | {
      readonly kind: 'continue';
      readonly capsule: Capsule;
      readonly repaired: boolean;
    }
  | { readonly kind: 'outcome'; readonly outcome: Outcome }
> {
  const checkpoint = await finishCheckpoint(job, capsule, intent, d);
  if (!checkpoint.done)
    return { kind: 'continue', capsule: checkpoint.capsule, repaired: false };
  const result = await verifyCheckpoint(
    job,
    checkpoint.capsule,
    checkpoint.sha,
    contract,
    repairs,
    d,
  );
  return result.kind === 'stop'
    ? { kind: 'outcome', outcome: result.outcome }
    : { kind: 'continue', capsule: result.capsule, repaired: true };
}
