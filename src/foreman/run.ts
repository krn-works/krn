// Checkpointed workers restart from the relay capsule with a fresh host session. ADR 0001.
import type { Job } from '../core/index.ts';
import {
  failureOutcome,
  finishSession,
  recoverLease,
  runSession,
} from './session.ts';
import { type Deps, type Outcome, validBudget } from './types.ts';

export async function runJob(job: Job, d: Deps): Promise<Outcome> {
  if (!validBudget(d))
    return d.stop(job, 'human_decision', ['invalid foreman budget']);
  const contract = await d.ledger.readContract(job.issue);
  let capsule = await d.relay.load(job, contract);
  const lease = await recoverLease(job, capsule, d);
  if (lease.outcome) return lease.outcome;
  capsule = lease.capsule;
  for (let resets = 0; resets <= d.budget.maxResets; resets += 1) {
    const facts = await d.relay.repoFacts(job);
    const valid = d.relay.validate(capsule, facts);
    if (!valid.ok) return d.stop(job, 'human_decision', valid.reasons);
    const intent = await d.trace.intent(job, capsule.epoch);
    try {
      const run = await runSession(job, capsule, facts, intent, d);
      if (run.checkpointed) {
        capsule = await d.relay.load(job, contract);
        continue;
      }
      return finishSession(job, run, d);
    } catch (error) {
      return failureOutcome(job, intent, error, d);
    }
  }
  return d.stop(job, 'human_decision', ['reset budget exhausted']);
}
