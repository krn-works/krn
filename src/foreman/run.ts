// Foreman owns the bounded J1 loop and its dependency contract. ADR 0001.

import type { Job } from '../core/index.ts';
import { finishCheckpoint } from './checkpoint.ts';
import { recoverLease, runAttempt } from './session.ts';
import { type Deps, type Outcome, validBudget } from './types.ts';
import { verifyCheckpoint } from './verdict.ts';

export async function runJob(job: Job, d: Deps): Promise<Outcome> {
  if (!validBudget(d))
    return d.stop(job, 'human_decision', ['invalid foreman budget']);
  const contract = await d.ledger.readContract(job.issue);
  let capsule = await d.relay.load(job, contract);
  let repairs = 0;
  if (capsule.pendingCheckpoint) {
    try {
      capsule = (
        await finishCheckpoint(
          job,
          capsule,
          capsule.pendingCheckpoint.intent,
          d,
        )
      ).capsule;
    } catch (error) {
      return d.stop(job, 'human_decision', [
        error instanceof Error ? error.message : 'checkpoint recovery failed',
      ]);
    }
  }
  const lease = await recoverLease(job, capsule, d);
  if (lease.outcome) return lease.outcome;
  capsule = lease.capsule;
  const resumedFacts = await d.relay.repoFacts(job, capsule.base);
  const resumedValid = d.relay.validate(capsule, resumedFacts);
  if (!resumedValid.ok)
    return d.stop(job, 'human_decision', resumedValid.reasons);
  if (
    capsule.nextAction === 'done' &&
    capsule.lease === 'checkpointed' &&
    (await d.relay.repoFacts(job, capsule.base)).head === capsule.head &&
    ((capsule.sessionId &&
      capsule.decisions.some(
        (entry) =>
          entry.source === capsule.sessionId &&
          entry.text.startsWith(`foreman commit ${capsule.head}: `),
      )) ||
      (await d.trace.hasVerdict?.(job, capsule.head)))
  ) {
    const replay = await verifyCheckpoint(
      job,
      capsule,
      capsule.head,
      contract,
      repairs,
      d,
    );
    if (replay.kind === 'stop') return replay.outcome;
    capsule = replay.capsule;
    repairs += 1;
  }
  for (
    let resets = 0;
    resets <= d.budget.maxResets + d.budget.maxRepairs;
    resets += 1
  ) {
    const facts = await d.relay.repoFacts(job, capsule.base);
    const valid = d.relay.validate(capsule, facts);
    if (!valid.ok) return d.stop(job, 'human_decision', valid.reasons);
    const attempt = await runAttempt(job, capsule, facts, contract, repairs, d);
    if (attempt.kind === 'outcome') return attempt.outcome;
    capsule = attempt.capsule;
    if (attempt.repaired) repairs += 1;
  }
  return d.stop(job, 'human_decision', ['reset budget exhausted']);
}
