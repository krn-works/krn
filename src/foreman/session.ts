// Host and trace I/O for one session stays outside the bounded orchestration loop. ADR 0001.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Job } from '../core/index.ts';
import { checkpointStep, isCheckpointRefusal } from './checkpoint.ts';
import { stateDirectory } from './state.ts';
import type {
  Capsule,
  Contract,
  Deps,
  Outcome,
  RepoFacts,
  Session,
  SessionEnd,
} from './types.ts';

export class AlreadyRunning extends Error {
  constructor() {
    super('already running');
  }
}

class ForemanAborted extends Error {}
class AbortedBeforeCheckpoint extends Error {}

export function endOutcome(
  job: Job,
  end: SessionEnd,
  d: Deps,
  noProgress = false,
): Outcome {
  return d.stop(job, 'human_decision', [
    end.dirtyPaths?.length
      ? `uncommitted_changes: reasonKind=${end.reasonKind}; paths=${end.dirtyPaths.join(',')}`
      : noProgress
        ? 'no_progress'
        : end.claimsDone
          ? 'S5/S6 verdict path is not enabled'
          : 'session ended without a checkpoint',
  ]);
}

export async function finishSession(
  job: Job,
  run: { readonly capsule: Capsule; readonly end: SessionEnd },
  d: Deps,
): Promise<Outcome> {
  const facts = await d.relay.repoFacts(job);
  const end = {
    ...run.end,
    claimsDone: false,
    dirtyPaths: facts.dirtyPaths ?? [],
  };
  const next = await d.relay.refreshCAS(run.capsule, facts, end);
  return next.applied
    ? endOutcome(job, end, d, facts.head === run.capsule.head)
    : d.stop(job, 'human_decision', ['capsule revision conflict']);
}

export async function failureOutcome(
  job: Job,
  intent: string,
  error: unknown,
  d: Deps,
): Promise<Outcome> {
  await d.trace.failure(job, intent, error);
  return d.stop(job, 'human_decision', [
    error instanceof AlreadyRunning
      ? 'already running'
      : 'worker or trace failure',
  ]);
}

export async function runAttempt(
  job: Job,
  capsule: Capsule,
  facts: RepoFacts,
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
  const stopped = (): {
    readonly kind: 'outcome';
    readonly outcome: Outcome;
  } => ({
    kind: 'outcome',
    outcome: d.stop(job, 'human_decision', ['stopped']),
  });
  if (d.signal?.aborted) return stopped();
  const intent = await d.trace.intent(job, capsule.epoch);
  if (d.signal?.aborted) return stopped();
  try {
    const run = await runSession(job, capsule, facts, contract, intent, d);
    if (!run.checkpointed || d.signal?.aborted)
      return { kind: 'outcome', outcome: await finishSession(job, run, d) };

    const checkpointDeps: Deps = {
      ...d,
      trace: {
        ...d.trace,
        checkpointRequest: async (requestJob, requestIntent, sessionId) => {
          const request = await d.trace.checkpointRequest(
            requestJob,
            requestIntent,
            sessionId,
          );
          if (d.signal?.aborted) throw new AbortedBeforeCheckpoint();
          return request;
        },
      },
    };
    try {
      return await checkpointStep(
        job,
        run.capsule,
        intent,
        contract,
        repairs,
        checkpointDeps,
      );
    } catch (error) {
      if (error instanceof AbortedBeforeCheckpoint)
        return { kind: 'outcome', outcome: await finishSession(job, run, d) };
      throw error;
    }
  } catch (error) {
    if (error instanceof ForemanAborted) return stopped();
    if (isCheckpointRefusal(error))
      return {
        kind: 'outcome',
        outcome: d.stop(job, 'human_decision', [error.message]),
      };
    return {
      kind: 'outcome',
      outcome: await failureOutcome(job, intent, error, d),
    };
  }
}

export async function runSession(
  job: Job,
  capsule: Capsule,
  facts: RepoFacts,
  contract: Contract,
  intent: string,
  d: Deps,
): Promise<{
  readonly end: SessionEnd;
  readonly checkpointed: boolean;
  readonly capsule: Capsule;
}> {
  if (d.signal?.aborted) throw new ForemanAborted();

  let session: Session | undefined;
  let sessionId: string | undefined;
  let bound = capsule;
  let startupBinding: Capsule | undefined;
  let cancellation: Promise<void> | undefined;
  let cancellationFailed = false;
  let cancellationError: unknown;
  let reportCancellationFailure!: () => void;
  const cancellationFailureSignal = new Promise<void>((resolve) => {
    reportCancellationFailure = resolve;
  });
  let poll: NodeJS.Timeout | undefined;
  let cancelTimer: NodeJS.Timeout | undefined;
  let pollInFlight = false;
  let pollingStopped = false;
  let pollFailed = false;
  let pollError: unknown;

  const cancelOwnedSession = (): void => {
    if (!sessionId || cancellation) return;
    try {
      cancellation = Promise.resolve(d.hosts.cancelTree(sessionId)).catch(
        (error: unknown) => {
          cancellationFailed = true;
          cancellationError = error;
          reportCancellationFailure();
        },
      );
    } catch (error) {
      cancellationFailed = true;
      cancellationError = error;
      reportCancellationFailure();
      cancellation = Promise.resolve();
    }
  };
  const onAbort = (): void => cancelOwnedSession();
  const stopPolling = (): void => {
    pollingStopped = true;
    if (poll) {
      clearInterval(poll);
      poll = undefined;
    }
    if (cancelTimer) {
      clearTimeout(cancelTimer);
      cancelTimer = undefined;
    }
  };

  d.signal?.addEventListener('abort', onAbort);
  if (d.signal?.aborted) onAbort();
  try {
    if (d.signal?.aborted) throw new ForemanAborted();
    session = await d.hosts.codex.start({
      cwd: job.worktree,
      model: 'gpt-6-luna',
      reasoningEffort: 'high',
      prompt: d.relay.project(capsule, facts, contract),
      limits: d.budget.session,
      checkpoint: {
        cli: fileURLToPath(new URL('../cli/main.ts', import.meta.url)),
        job: job.id,
        issue: job.issue,
        worktree: job.worktree,
        ...(job.repoRoot === undefined ? {} : { repoRoot: job.repoRoot }),
        ...(job.checkpoint === undefined
          ? {}
          : {
              message: job.checkpoint.message,
              next: job.checkpoint.next,
            }),
        intent,
      },
      onStarted: async (startedId, pgid, isolation, registration) => {
        sessionId = startedId;
        if (d.signal?.aborted) cancelOwnedSession();
        const result = await d.relay.bindSession(job, capsule, startedId);
        if (!result.applied) throw new AlreadyRunning();
        bound = result.value;
        startupBinding = result.value;
        if (
          !(await d.trace.started(
            job,
            intent,
            startedId,
            pgid,
            isolation,
            registration,
          ))
        )
          throw new AlreadyRunning();
        if (d.signal?.aborted) {
          cancelOwnedSession();
          throw new ForemanAborted();
        }
        return true;
      },
      onStartCancelled: async (cancelledId) => {
        const owned = startupBinding;
        if (!owned) return;
        if (owned.sessionId !== cancelledId)
          throw new Error(
            'startup cancellation session does not match bound lease',
          );
        const released = await d.relay.releaseStartupLease(
          job,
          owned,
          cancelledId,
        );
        if (!released.applied)
          throw new Error('startup lease handback CAS conflict');
        bound = released.value;
      },
    });
    const running = session;
    if (!sessionId || running.id !== sessionId)
      throw new Error('host session identity differs from startup binding');
    let checkpointed = false;
    if (d.signal?.aborted) cancelOwnedSession();

    poll = setInterval(() => {
      if (pollingStopped || pollInFlight) return;
      pollInFlight = true;
      void (async () => {
        try {
          const found = await d.trace.hasCheckpoint(job, intent, running.id);
          if (pollingStopped || !found || checkpointed) return;
          checkpointed = true;
          cancelTimer = setTimeout(cancelOwnedSession, 5_000);
        } catch (error) {
          if (pollingStopped) return;
          pollFailed = true;
          pollError = error;
          cancelOwnedSession();
        } finally {
          pollInFlight = false;
        }
      })();
    }, 1000);
    poll.unref();

    const waitResult = await Promise.race([
      running.wait().then(
        (value) => ({ kind: 'ended' as const, value }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      ),
      cancellationFailureSignal.then(() => ({
        kind: 'cancel-failed' as const,
      })),
    ]);
    if (waitResult.kind === 'cancel-failed')
      throw pollFailed
        ? new AggregateError(
            [pollError, cancellationError],
            'session checkpoint polling and cancellation failed',
          )
        : cancellationError;
    if (waitResult.kind === 'error') throw waitResult.error;
    const { finalMessage, ...end } = waitResult.value;
    stopPolling();
    if (d.signal?.aborted) cancelOwnedSession();
    if (cancellation) await cancellation;
    if (pollFailed) throw pollError;
    if (cancellationFailed) throw cancellationError;

    checkpointed ||= await d.trace.hasCheckpoint(job, intent, running.id);
    if (
      !checkpointed &&
      !(await d.relay.isCurrent(job, bound.epoch, running.id))
    )
      throw new Error('stale worker session');
    if (process.env.KRN_LIVE_DIAG === '1' && finalMessage !== undefined) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(job.id) || job.id === '..')
        throw new Error('invalid diagnostic job id');
      const directory = stateDirectory(job);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(directory, 'reason.txt'),
        finalMessage.slice(0, 2000),
        {
          mode: 0o600,
        },
      );
    }
    await d.trace.log(job, intent, running.id, 'session_ended', end);
    if (d.signal?.aborted) cancelOwnedSession();
    if (cancellation) await cancellation;
    if (cancellationFailed) throw cancellationError;
    return {
      end: { ...end, claimsDone: false },
      checkpointed,
      capsule: bound,
    };
  } catch (error) {
    stopPolling();
    if (session) cancelOwnedSession();
    if (cancellation) await cancellation;
    if (
      cancellationFailed &&
      error !== cancellationError &&
      !(
        error instanceof AggregateError &&
        error.errors.includes(cancellationError)
      )
    )
      throw new AggregateError(
        [error, cancellationError],
        'foreman session cancellation failed',
      );
    if (error instanceof ForemanAborted && !cancellationFailed) throw error;
    throw error;
  } finally {
    d.signal?.removeEventListener('abort', onAbort);
    if (poll) clearInterval(poll);
    if (cancelTimer) clearTimeout(cancelTimer);
  }
}

export async function recoverLease(
  job: Job,
  capsule: Capsule,
  d: Deps,
): Promise<{ readonly capsule: typeof capsule; readonly outcome?: Outcome }> {
  if (!capsule.sessionId || capsule.lease === 'checkpointed')
    return { capsule };
  const end = await d.trace.sessionEnd(job, capsule.sessionId);
  if (!end) {
    const registration = await d.trace.sessionScopeRegistration?.(
      job,
      capsule.sessionId,
    );
    const scopeActive = registration
      ? await d.hosts.sessionScopeActive?.(
          job.id,
          capsule.sessionId,
          registration,
        )
      : null;
    if (registration && scopeActive === false && d.trace.sessionLost) {
      const facts = await d.relay.repoFacts(job);
      const lost = {
        reasonKind: 'session_lost',
        claimsDone: false,
        dirtyPaths: facts.dirtyPaths ?? [],
      };
      await d.trace.sessionLost(job, capsule.sessionId, lost.dirtyPaths);
      const recovered = await d.relay.refreshCAS(capsule, facts, lost);
      if (!recovered.applied)
        return {
          capsule,
          outcome: d.stop(job, 'human_decision', [
            'session recovery CAS conflict',
          ]),
        };
      return { capsule: recovered.value };
    }
    return {
      capsule,
      outcome: d.stop(job, 'human_decision', ['already running']),
    };
  }
  const facts = await d.relay.repoFacts(job);
  const recovered = await d.relay.refreshCAS(capsule, facts, end);
  if (!recovered.applied)
    return {
      capsule,
      outcome: d.stop(job, 'human_decision', ['session recovery CAS conflict']),
    };
  if (facts.head === capsule.head)
    return {
      capsule: recovered.value,
      outcome: d.stop(job, 'human_decision', ['no_progress']),
    };
  if (end.claimsDone)
    return {
      capsule: recovered.value,
      outcome: d.stop(job, 'human_decision', [
        'S5/S6 verdict path is not enabled',
      ]),
    };
  return { capsule: recovered.value };
}
