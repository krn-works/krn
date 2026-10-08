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
  const intent = await d.trace.intent(job, capsule.epoch);
  try {
    const run = await runSession(job, capsule, facts, intent, d);
    if (!run.checkpointed)
      return { kind: 'outcome', outcome: await finishSession(job, run, d) };
    const step = await checkpointStep(
      job,
      run.capsule,
      intent,
      contract,
      repairs,
      d,
    );
    return step;
  } catch (error) {
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
  intent: string,
  d: Deps,
): Promise<{
  readonly end: SessionEnd;
  readonly checkpointed: boolean;
  readonly capsule: Capsule;
}> {
  let session: Session | undefined;
  let bound = capsule;
  try {
    session = await d.hosts.codex.start({
      cwd: job.worktree,
      model: 'gpt-6-luna',
      prompt: d.relay.project(capsule, facts),
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
      onStarted: async (sessionId, pgid, isolation) => {
        const result = await d.relay.bindSession(job, capsule, sessionId);
        if (!result.applied) throw new AlreadyRunning();
        bound = result.value;
        if (!(await d.trace.started(job, intent, sessionId, pgid, isolation)))
          throw new AlreadyRunning();
        return true;
      },
    });
    const running = session;
    let checkpointed = false;
    let pollError: unknown;
    let cancelTimer: NodeJS.Timeout | undefined;
    const poll = setInterval(() => {
      void d.trace
        .hasCheckpoint(job, intent, running.id)
        .then((found) => {
          if (!found || checkpointed) return;
          checkpointed = true;
          cancelTimer = setTimeout(
            () => void d.hosts.cancelTree(running.id),
            5_000,
          );
        })
        .catch((error: unknown) => {
          pollError = error;
          void d.hosts.cancelTree(running.id).catch((cancelError: unknown) => {
            pollError = cancelError;
          });
        });
    }, 1000);
    poll.unref();
    const { finalMessage, ...end } = await running.wait();
    clearInterval(poll);
    if (cancelTimer) clearTimeout(cancelTimer);
    if (pollError !== undefined) throw pollError;
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
    return {
      end: { ...end, claimsDone: false },
      checkpointed,
      capsule: bound,
    };
  } catch (error) {
    if (session) await d.hosts.cancelTree(session.id);
    throw error;
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
  if (!end)
    return {
      capsule,
      outcome: d.stop(job, 'human_decision', ['already running']),
    };
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
