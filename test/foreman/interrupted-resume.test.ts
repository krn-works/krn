import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as foreman from '../../src/foreman/index.ts';
import { runJob } from '../../src/foreman/run.ts';
import type { Capsule, Deps } from '../../src/foreman/types.ts';
import * as relay from '../../src/relay/index.ts';

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
      load: async () => ({ epoch, head: 'a'.repeat(40) }) as Capsule,
      checkpoint: async () =>
        ({ epoch: ++epoch, head: 'a'.repeat(40) }) as Capsule,
      bindSession: async (_job, capsule, _sessionId) => ({
        applied: true as const,
        value: { ...capsule, epoch: ++epoch },
      }),
      isCurrent: async (_job, value) => value === epoch,
      repoFacts: async () => ({
        base: 'a'.repeat(40),
        head: 'a'.repeat(40),
        branch: 'main',
        worktree: '/tmp/job-1',
      }),
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
      sessionEnd: async () => null,
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
                  'continue with step B',
                );
                await d.hosts.cancelTree(id);
                return { reasonKind: 'interrupted', claimsDone: false };
              }
              return { reasonKind: 'exit', claimsDone: true };
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

test('a concurrent run cannot replace the active capsule session', async () => {
  const worktree = await mkdtemp(join(tmpdir(), 'krn-foreman-active-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', worktree, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q', '--initial-branch=main']);
  await writeFile(join(worktree, 'README.md'), 'active lease fixture\n');
  git(['add', 'README.md']);
  git([
    '-c',
    'user.name=Foreman Test',
    '-c',
    'user.email=foreman@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);

  const job = { id: 'job-active', issue: 'issue-active', worktree };
  const started: string[] = [];
  let release!: () => void;
  const hold = new Promise<{ reasonKind: string; claimsDone: boolean }>(
    (resolve) => {
      release = () => resolve({ reasonKind: 'exit', claimsDone: true });
    },
  );
  const d: Deps = {
    budget: { maxResets: 3, maxRepairs: 2, session: { timeoutMs: 1000 } },
    ledger: { readContract: async () => ({ revision: 'rev-1' }) },
    relay,
    trace: {
      intent: async (_job, epoch) => `intent-${epoch}`,
      started: async () => true,
      checkpoint: async () => undefined,
      hasCheckpoint: async () => false,
      sessionEnd: async () => null,
      log: async () => undefined,
      failure: async () => undefined,
    },
    hosts: {
      codex: {
        start: async (input) => {
          const id = `session-${started.length + 1}`;
          assert.equal(await input.onStarted(id), true);
          started.push(id);
          return {
            id,
            wait: async () =>
              id === 'session-1'
                ? hold
                : { reasonKind: 'exit', claimsDone: true },
          };
        },
      },
      cancelTree: async () => undefined,
    },
    stop: (_job, state, reasons) => ({ kind: 'stop', state, reasons }),
  };

  try {
    const first = runJob(job, d);
    await waitFor(() => started.length === 1);
    const second = await runJob(job, d);
    assert.equal(
      started.length,
      1,
      'the second invocation must not start a worker session',
    );
    assert.deepEqual(second, {
      kind: 'stop',
      state: 'human_decision',
      reasons: ['already running'],
    });
    release();
    await first;
  } finally {
    release();
    await rm(worktree, { recursive: true, force: true });
  }
});

async function waitFor(read: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!read() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(read(), true, 'timed out waiting for the fake session to start');
}
