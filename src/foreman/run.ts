// Checkpointed workers restart from the relay capsule with a fresh host session. ADR 0001.
import type { Job } from '../core/index.ts';
import { runSession } from './session.ts';
import { type Deps, type Outcome, validBudget } from './types.ts';

export async function runJob(job: Job, d: Deps): Promise<Outcome> {
  if (!validBudget(d))
    return d.stop(job, 'human_decision', ['invalid foreman budget']);
  const contract = await d.ledger.readContract(job.issue);
  let capsule = await d.relay.load(job, contract);
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
      const next = await d.relay.refreshCAS(
        run.capsule,
        await d.relay.repoFacts(job),
        run.end,
      );
      if (!next.applied)
        return d.stop(job, 'human_decision', ['capsule revision conflict']);
      return d.stop(job, 'human_decision', [
        run.end.claimsDone
          ? 'S5/S6 verdict path is not enabled'
          : 'session ended without a checkpoint',
      ]);
    } catch (error) {
      await d.trace.failure(job, intent, error);
      return d.stop(job, 'human_decision', ['worker or trace failure']);
    }
  }
  return d.stop(job, 'human_decision', ['reset budget exhausted']);
}
