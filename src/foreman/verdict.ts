// A completed checkpoint only advances with deterministic checks on its SHA. ADR 0001.
import type { Job } from '../core/index.ts';
import { judge } from '../verdict/index.ts';
import type { Capsule, Contract, Deps, Outcome } from './types.ts';

export async function verifyCheckpoint(
  job: Job,
  capsule: Capsule,
  sha: string,
  contract: Contract,
  repairs: number,
  d: Deps,
): Promise<
  | { readonly kind: 'repair'; readonly capsule: Capsule }
  | { readonly kind: 'stop'; readonly outcome: Outcome }
> {
  const verdict = await judge(
    job,
    sha,
    capsule.base,
    contract.checks ?? [],
    (event) => d.trace.verdict?.(job, event) ?? Promise.resolve(),
  );
  if (verdict.kind === 'pass')
    return {
      kind: 'stop',
      outcome: { kind: 'verdict_pass', state: 'human_decision', sha },
    };
  if (verdict.kind === 'refused' || repairs >= d.budget.maxRepairs)
    return {
      kind: 'stop',
      outcome: d.stop(job, 'human_decision', verdict.findings.slice(0, 2)),
    };
  if (!d.relay.withFindingsCAS)
    return {
      kind: 'stop',
      outcome: d.stop(job, 'human_decision', ['verdict repair unavailable']),
    };
  const repair = await d.relay.withFindingsCAS(
    capsule,
    verdict.findings.slice(0, 2),
  );
  return repair.applied
    ? { kind: 'repair', capsule: repair.value }
    : {
        kind: 'stop',
        outcome: d.stop(job, 'human_decision', [
          'verdict findings CAS conflict',
        ]),
      };
}
