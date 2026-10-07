// Host and trace I/O for one session stays outside the bounded orchestration loop. ADR 0001.
import { fileURLToPath } from 'node:url';

import type { Job } from '../core/index.ts';
import type {
  Capsule,
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

export function endOutcome(job: Job, end: SessionEnd, d: Deps): Outcome {
  return d.stop(job, 'human_decision', [
    end.claimsDone
      ? 'S5/S6 verdict path is not enabled'
      : 'session ended without a checkpoint',
  ]);
}

export async function finishSession(
  job: Job,
  run: { readonly capsule: Capsule; readonly end: SessionEnd },
  d: Deps,
): Promise<Outcome> {
  const next = await d.relay.refreshCAS(
    run.capsule,
    await d.relay.repoFacts(job),
    run.end,
  );
  return next.applied
    ? endOutcome(job, run.end, d)
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
        intent,
      },
      onStarted: async (sessionId) => {
        const result = await d.relay.bindSession(job, capsule, sessionId);
        if (!result.applied) throw new AlreadyRunning();
        bound = result.value;
        if (!(await d.trace.started(job, intent, sessionId)))
          throw new AlreadyRunning();
        return true;
      },
    });
    const end = await session.wait();
    const checkpointed = await d.trace.hasCheckpoint(job, intent, session.id);
    if (
      !checkpointed &&
      !(await d.relay.isCurrent(job, bound.epoch, session.id))
    )
      throw new Error('stale worker session');
    await d.trace.log(job, intent, session.id, 'session_ended', end);
    return {
      end,
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
  if (!capsule.sessionId || capsule.nextAction === 'resume after checkpoint')
    return { capsule };
  const end = await d.trace.sessionEnd(job, capsule.sessionId);
  if (!end)
    return {
      capsule,
      outcome: d.stop(job, 'human_decision', ['already running']),
    };
  const recovered = await d.relay.refreshCAS(
    capsule,
    await d.relay.repoFacts(job),
    end,
  );
  if (!recovered.applied)
    return {
      capsule,
      outcome: d.stop(job, 'human_decision', ['session recovery CAS conflict']),
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
