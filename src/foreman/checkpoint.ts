import type { Job } from '../core/index.ts';
import {
  commitPrepared,
  prepareCheckpoint,
  preparedCommitMismatch,
} from './commit.ts';
import type { Capsule, Contract, Deps, Outcome } from './types.ts';
import { verifyCheckpoint } from './verdict.ts';

export function isCheckpointRefusal(error: unknown): error is Error {
  return (
    error instanceof Error && error.message.startsWith('checkpoint refused:')
  );
}

type Checkpoint = {
  readonly capsule: Capsule;
  readonly sha: string;
  readonly done: boolean;
};

type CheckpointResult =
  | {
      readonly kind: 'continue';
      readonly capsule: Capsule;
      readonly repaired: boolean;
    }
  | { readonly kind: 'outcome'; readonly outcome: Outcome };

export async function finishCheckpoint(
  job: Job,
  capsule: Capsule,
  intent: string,
  d: Deps,
): Promise<Checkpoint> {
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
  // Everything that could refuse the commit record is decided before HEAD moves.
  d.relay.admitCommit(job, sessionId, request.message);
  const prepared = prepareCheckpoint(job, request.message, sessionId);
  await d.trace.commitIntent(job, intent, sessionId, prepared);
  const sha = commitPrepared(job, prepared);
  await d.trace.commit(job, intent, sessionId, sha, request.message);
  const committed = await d.relay.recordCommit(
    job,
    sessionId,
    sha,
    request.message,
  );
  return { capsule: committed, sha, done: request.next === 'done' };
}

async function continueAfterCheckpoint(
  job: Job,
  checkpoint: Checkpoint,
  contract: Contract,
  repairs: number,
  d: Deps,
): Promise<CheckpointResult> {
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

export async function checkpointStep(
  job: Job,
  capsule: Capsule,
  intent: string,
  contract: Contract,
  repairs: number,
  d: Deps,
): Promise<CheckpointResult> {
  const checkpoint = await finishCheckpoint(job, capsule, intent, d);
  return continueAfterCheckpoint(job, checkpoint, contract, repairs, d);
}

// Adopt the one commit an interrupted checkpoint left behind, or explain why not.
async function adoptInterruptedCommit(
  job: Job,
  capsule: Capsule,
  head: string,
  d: Deps,
): Promise<Checkpoint | string> {
  const sessionId = capsule.sessionId;
  if (!sessionId || capsule.lease !== 'checkpointed')
    return 'no interrupted checkpoint is bound';
  const record = await d.trace.checkpointCommit(job, sessionId);
  if (!record) return 'no recorded commit intent for the checkpoint session';
  if (record.parent !== capsule.head)
    return 'recorded commit intent does not start at the capsule HEAD';
  if (record.sha !== undefined && record.sha !== head)
    return 'recorded checkpoint commit differs from HEAD';
  if (capsule.nextAction !== record.next)
    return 'capsule next action differs from the checkpoint request';
  const requested = capsule.decisions.findLastIndex(
    (entry) =>
      entry.source === sessionId &&
      entry.text === `commit request: ${record.message}`,
  );
  if (
    requested === -1 ||
    capsule.decisions
      .slice(requested)
      .some((entry) => entry.text.startsWith('foreman commit '))
  )
    return 'capsule does not hold an unrecorded commit request';
  const mismatch = preparedCommitMismatch(job, { ...record, sessionId }, head);
  if (mismatch) return mismatch;
  await d.trace.commit(job, record.intent, sessionId, head, record.message);
  return {
    capsule: await d.relay.recordCommit(job, sessionId, head, record.message),
    sha: head,
    done: record.next === 'done',
  };
}

export async function recoverInterruptedCheckpoint(
  job: Job,
  capsule: Capsule,
  contract: Contract,
  repairs: number,
  d: Deps,
): Promise<CheckpointResult | null> {
  if (capsule.lease !== 'checkpointed' || !capsule.sessionId) return null;
  const facts = await d.relay.repoFacts(job);
  if (facts.head === capsule.head) return null;
  if (facts.worktree !== capsule.worktree || facts.branch !== capsule.branch)
    return null;
  let adopted: Checkpoint | string;
  try {
    adopted = await adoptInterruptedCommit(job, capsule, facts.head, d);
  } catch (error) {
    adopted = error instanceof Error ? error.message : String(error);
  }
  if (typeof adopted === 'string')
    return {
      kind: 'outcome',
      outcome: d.stop(job, 'human_decision', [
        'HEAD changed',
        `checkpoint commit not adopted: ${adopted}`,
      ]),
    };
  return continueAfterCheckpoint(job, adopted, contract, repairs, d);
}
