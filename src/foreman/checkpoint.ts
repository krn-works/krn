import type { Job } from '../core/index.ts';
import { prepareCheckpoint, publishCheckpoint } from './commit.ts';
import type { Capsule, Contract, Deps, Outcome } from './types.ts';
import { AbortBeforeCheckpoint } from './types.ts';
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
  let prepared = capsule.pendingCheckpoint;
  let checkpointed = capsule;
  if (!prepared) {
    // Close the await gap immediately before preparing a fresh checkpoint.
    if (d.signal?.aborted) throw new AbortBeforeCheckpoint();
    const commit = prepareCheckpoint(job, request.message, sessionId);
    checkpointed = await d.relay.checkpoint(
      job,
      sessionId,
      request.message,
      request.next,
      request.decision,
      { ...commit, intent, expectedEpoch: capsule.epoch },
    );
    prepared = { ...commit, intent, epoch: checkpointed.epoch };
  } else {
    const facts = await d.relay.repoFacts(job, capsule.base);
    const priorRequest = [...capsule.decisions]
      .reverse()
      .find(
        (entry) =>
          entry.source === sessionId &&
          entry.text.startsWith('commit request: '),
      );
    if (
      prepared.epoch !== capsule.epoch ||
      prepared.intent !== intent ||
      prepared.parent !== capsule.head ||
      capsule.lease !== 'checkpointed' ||
      capsule.nextAction !== request.next ||
      priorRequest?.text !== `commit request: ${request.message}` ||
      capsule.decisions.at(-1)?.text !==
        (request.decision ?? `commit request: ${request.message}`) ||
      facts.worktree !== capsule.worktree ||
      facts.branch !== capsule.branch ||
      facts.base !== capsule.base ||
      (facts.head !== prepared.parent && facts.head !== prepared.sha)
    )
      throw new Error(
        'checkpoint refused: pending checkpoint ownership changed',
      );
  }
  if (!(await d.relay.isCurrent(job, checkpointed.epoch, sessionId)))
    throw new Error('checkpoint refused: capsule ownership changed');
  await d.trace.checkpoint(
    job,
    intent,
    sessionId,
    request.message,
    request.next,
    request.decision,
  );
  if (!(await d.relay.isCurrent(job, checkpointed.epoch, sessionId)))
    throw new Error('checkpoint refused: capsule ownership changed');
  const publishFacts = await d.relay.repoFacts(job, capsule.base);
  // Accept only the two HEADs belonging to this prepared transition; all
  // other repository anchors still pass through the existing validation.
  const valid = d.relay.validate(
    {
      ...checkpointed,
      head: publishFacts.head === prepared.sha ? prepared.sha : prepared.parent,
    },
    publishFacts,
  );
  if (!valid.ok)
    throw new Error(`checkpoint refused: ${valid.reasons.join(', ')}`);
  publishCheckpoint(
    job,
    prepared.sha,
    prepared.parent,
    request.message,
    sessionId,
  );
  const sha = prepared.sha;
  await d.trace.commit(job, intent, sessionId, sha, request.message);
  const committed = await d.relay.recordCommit(
    job,
    sessionId,
    sha,
    request.message,
    checkpointed.epoch,
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
