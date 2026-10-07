// Host and trace I/O for one session stays outside the bounded orchestration loop. ADR 0001.
import { fileURLToPath } from 'node:url';

import type { Job } from '../core/index.ts';
import type { Deps, Session, SessionEnd } from './types.ts';

export async function runSession(
  job: Job,
  capsule: { readonly epoch: number; readonly head: string },
  facts: { readonly head: string; readonly fingerprint: string },
  intent: string,
  d: Deps,
): Promise<{
  readonly end: SessionEnd;
  readonly checkpointed: boolean;
  readonly capsule: { readonly epoch: number; readonly head: string };
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
        if (!result.applied) return false;
        bound = result.value;
        return d.trace.started(job, intent, sessionId);
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
