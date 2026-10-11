// A completed checkpoint only advances with deterministic checks on its SHA. ADR 0001.
import type { Job } from '../core/index.ts';
import type { CheckEvidence } from '../verdict/index.ts';
import { judge } from '../verdict/index.ts';
import { git } from './git.ts';
import type { Capsule, Contract, Deps, Outcome } from './types.ts';

export async function reportPassingVerdict(
  job: Job,
  contract: Contract,
  sha: string,
  checks: readonly CheckEvidence[],
  ledger: Pick<Deps['ledger'], 'submitForReview'> & {
    readonly submissionEnabled?: boolean;
  },
  trace: Pick<
    Deps['trace'],
    | 'readyForReview'
    | 'paperclipUpdateStarted'
    | 'submitIntent'
    | 'submittedFor'
    | 'submitted'
    | 'submissionReconciledFor'
    | 'submissionReconciled'
  >,
  stop: Deps['stop'],
  signal?: AbortSignal,
): Promise<Outcome> {
  const priorReconciliation = await trace.submissionReconciledFor?.(job, sha);
  if (signal?.aborted) return stop(job, 'human_decision', ['stopped']);
  if (priorReconciliation === 'submitted')
    return {
      kind: 'verdict_pass',
      state: 'in_review',
      sha,
    };
  if (priorReconciliation)
    return stop(job, 'human_decision', [
      priorReconciliation === 'board_conflict'
        ? 'board_conflict'
        : 'Paperclip review submission refused',
    ]);
  const reconcile =
    ledger.submissionEnabled === false
      ? false
      : ((await trace.submitIntent?.(job, sha, contract.revision)) ?? false);
  if (signal?.aborted) return stop(job, 'human_decision', ['stopped']);
  const priorReceipt = reconcile
    ? ((await trace.submittedFor?.(job, sha)) ?? undefined)
    : undefined;
  if (signal?.aborted) return stop(job, 'human_decision', ['stopped']);
  let session: string | undefined;
  if (ledger.submissionEnabled === true) {
    try {
      session = git(job, [
        'show',
        '-s',
        '--format=%(trailers:key=Krn-Session,valueonly)',
        sha,
      ]).trim();
    } catch {
      session = undefined;
    }
    if (!session || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(session))
      return stop(job, 'human_decision', [
        'verified commit is missing a valid Krn-Session trailer',
      ]);
  }
  const submitted = await ledger.submitForReview(
    job,
    contract,
    { kind: 'verdict_pass', sha, checks },
    sha,
    {
      ...(signal === undefined ? {} : { signal }),
      ...(session === undefined ? {} : { session }),
      reconcile,
      ...(priorReceipt === undefined ? {} : { priorReceipt }),
      onWriteStarted: (kind) => trace.paperclipUpdateStarted?.(job, sha, kind),
      onSubmitted: (receipt) => trace.submitted?.(job, sha, receipt),
      onReconciled: (result) => trace.submissionReconciled?.(job, sha, result),
    },
  );
  if (signal?.aborted) return stop(job, 'human_decision', ['stopped']);
  if (submitted === 'ready_for_review') {
    await trace.readyForReview?.(job, sha);
    return { kind: 'verdict_pass', state: 'ready_for_review', sha };
  }
  return submitted === 'submitted'
    ? { kind: 'verdict_pass', state: 'in_review', sha }
    : stop(job, 'human_decision', [
        submitted === 'stopped'
          ? 'stopped'
          : submitted === 'board_conflict'
            ? 'board_conflict'
            : submitted === 'board_changed'
              ? 'board_changed'
              : 'Paperclip review submission refused',
      ]);
}

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
  if (capsule.head !== sha)
    return {
      kind: 'stop',
      outcome: d.stop(job, 'human_decision', [
        'verdict SHA differs from recorded commit',
      ]),
    };
  const verdict = await judge(
    job,
    sha,
    capsule.base,
    contract.checks ?? [],
    (event) => d.trace.verdict?.(job, event) ?? Promise.resolve(),
    d.signal,
  );
  if (verdict.kind === 'pass') {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (d.signal?.aborted)
      return {
        kind: 'stop',
        outcome: d.stop(job, 'human_decision', ['stopped']),
      };
    return {
      kind: 'stop',
      outcome: await reportPassingVerdict(
        job,
        contract,
        sha,
        verdict.checks,
        d.ledger,
        d.trace,
        d.stop,
        d.signal,
      ),
    };
  }
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
