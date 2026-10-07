import assert from 'node:assert/strict';
import test from 'node:test';

import * as foreman from '../../src/foreman/index.ts';
import type { Deps } from '../../src/foreman/types.ts';

test('checkpoint interruption resumes one action in a fresh session', async () => {
  const sessions: string[] = [];
  const actionSessions: string[] = [];
  let epoch = 0;
  let checkpointed = false;
  const d: Deps = {
    budget: { maxResets: 3, maxRepairs: 2, session: { timeoutMs: 1000 } },
    ledger: {
      readContract: async () => ({ revision: 'rev-1' }),
    },
    relay: {
      load: async () => ({ epoch, head: 'a'.repeat(40) }),
      checkpoint: async () => ({ epoch: ++epoch, head: 'a'.repeat(40) }),
      bindSession: async (_job, capsule, _sessionId) => ({
        applied: true as const,
        value: { ...capsule, epoch: ++epoch },
      }),
      isCurrent: async (_job, value) => value === epoch,
      repoFacts: async () => ({ head: 'a'.repeat(40), fingerprint: 'clean' }),
      validate: () => ({ ok: true as const }),
      project: () => 'perform action exactly once',
      refreshCAS: async (capsule, _facts, end) => {
        epoch += 1;
        return { applied: true as const, value: { ...capsule, epoch, end } };
      },
    },
    trace: {
      intent: async (_job, value) => `intent-${value}`,
      started: async () => true,
      log: async () => undefined,
      failure: async () => undefined,
      checkpoint: async () => {
        checkpointed = true;
        epoch += 1;
      },
      hasCheckpoint: async (_job, _intent, sessionId) =>
        checkpointed && sessionId === 'session-1',
    },
    hosts: {
      codex: {
        start: async (input) => {
          const id = `session-${sessions.length + 1}`;
          assert.equal(await input.onStarted(id), true);
          sessions.push(id);
          if (checkpointed) actionSessions.push(id);
          return {
            id,
            wait: async () => {
              if (sessions.length === 1) {
                await d.trace.checkpoint(
                  { id: 'job-1', issue: 'issue-1', worktree: '/tmp/job-1' },
                  'intent-0',
                  id,
                );
                await d.hosts.cancelTree(id);
                return { reason: 'interrupted', claimsDone: false };
              }
              return { reason: 'exit', claimsDone: true };
            },
          };
        },
      },
      cancelTree: async () => undefined,
    },
    stop: (_job, state, reasons) => ({ kind: 'stop' as const, state, reasons }),
  };
  const runJob = Reflect.get(foreman, 'runJob') as (
    job: { id: string; issue: string; worktree: string },
    deps: Deps,
  ) => Promise<unknown>;

  let outcome: unknown;
  await assert.doesNotReject(async () => {
    outcome = await runJob(
      { id: 'job-1', issue: 'issue-1', worktree: '/tmp/job-1' },
      d,
    );
  });
  assert.equal(checkpointed, true);
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0], sessions[1]);
  assert.deepEqual(actionSessions, [sessions[1]]);
  assert.deepEqual(outcome, {
    kind: 'stop',
    state: 'human_decision',
    reasons: ['S5/S6 verdict path is not enabled'],
  });
});
