import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as foreman from '../../src/foreman/index.ts';
import { runJob } from '../../src/foreman/run.ts';
import { recoverLease } from '../../src/foreman/session.ts';
import type { Capsule, Deps } from '../../src/foreman/types.ts';
import { reportPassingVerdict } from '../../src/foreman/verdict.ts';
import type {
  Contract,
  SubmitForReviewOptions,
  VerdictEvidence,
} from '../../src/ledger/index.ts';
import * as relay from '../../src/relay/index.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

test('resuming a ready_for_review checkpoint re-verdicts without starting a session', async (t) => {
  if (
    !requiresIsolation(
      t,
      'resuming a ready_for_review checkpoint re-verdicts without starting a session',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
  const scratch = join(process.cwd(), '.krn', 'tmp');
  await mkdir(scratch, { recursive: true });
  const worktree = await mkdtemp(join(scratch, 'krn-foreman-ready-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', worktree, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q', '--initial-branch=main']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(worktree, '.gitignore'), '.krn/\n');
  await writeFile(
    join(worktree, 'krn.checks.json'),
    JSON.stringify({
      version: 1,
      checks: [{ id: 'declared', argv: ['/usr/bin/true'], timeoutMs: 3000 }],
    }),
  );
  git(['add', '.gitignore', 'krn.checks.json']);
  git(['commit', '-qm', 'fixture']);
  const head = git(['rev-parse', 'HEAD']);
  const job = {
    id: 'ready-resume',
    issue: 'issue-ready',
    worktree,
    repoRoot: worktree,
  };
  let sessions = 0;
  let verdicts = 0;
  let submissions = 0;
  const capsule = {
    jobId: job.id,
    issue: job.issue,
    contractRevision: 'rev-1',
    epoch: 0,
    base: head,
    head,
    branch: 'main',
    worktree,
    nextAction: 'done',
    lease: 'checkpointed' as const,
    blockers: [],
    decisions: [],
    rejectedApproaches: [],
    references: [],
  };
  const d: Deps = {
    budget: { maxResets: 3, maxRepairs: 0, session: { timeoutMs: 1000 } },
    signal: new AbortController().signal,
    ledger: {
      readContract: async () => ({
        issueId: job.issue,
        identifier: 'ready',
        title: 'ready',
        description: 'ready',
        revision: 'rev-1',
        targetRepo: 'fixture/repo',
        checks: ['declared'],
      }),
      submitForReview: async () => {
        submissions += 1;
        return 'ready_for_review';
      },
    },
    relay: {
      load: async () => capsule,
      repoFacts: async () => ({ base: head, head, branch: 'main', worktree }),
      validate: () => ({ ok: true }),
      project: () => 'unused',
    } as unknown as Deps['relay'],
    trace: {
      hasVerdict: async (_job, sha) => sha === head,
      verdict: async () => {
        verdicts += 1;
      },
      readyForReview: async () => undefined,
      intent: async () => 'unused',
      started: async () => true,
      checkpoint: async () => undefined,
      checkpointRequest: async () => null,
      commit: async () => undefined,
      commitIntent: async () => undefined,
      checkpointCommit: async () => null,
      hasCheckpoint: async () => false,
      sessionEnd: async () => null,
      log: async () => undefined,
      failure: async () => undefined,
    },
    hosts: {
      codex: {
        start: async () => {
          sessions += 1;
          throw new Error('session must not start');
        },
      },
      cancelTree: async () => undefined,
    },
    stop: (_job, state, reasons) => ({ kind: 'stop', state, reasons }),
  };
  try {
    const outcome = await runJob(job, d);
    assert.deepEqual(outcome, {
      kind: 'verdict_pass',
      state: 'ready_for_review',
      sha: head,
    });
    assert.equal(sessions, 0);
    assert.equal(verdicts, 1);
    assert.equal(submissions, 1);
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});

test('checkpoint interruption resumes one action in a fresh session', async () => {
  const worktree = await mkdtemp(join(tmpdir(), 'krn-foreman-resume-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', worktree, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q', '--initial-branch=main']);
  await writeFile(join(worktree, 'README.md'), 'fixture\n');
  git(['add', 'README.md']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  const job = { id: 'job-1', issue: 'issue-1', worktree };
  const sessions: string[] = [];
  const actionSessions: string[] = [];
  let epoch = 0;
  let checkpointed = false;
  const d: Deps = {
    budget: { maxResets: 3, maxRepairs: 2, session: { timeoutMs: 1000 } },
    ledger: {
      readContract: async () => ({
        issueId: 'issue-1',
        identifier: 'issue-1',
        title: 'resume fixture',
        description: 'resume fixture',
        revision: 'rev-1',
        targetRepo: 'fixture/repo',
        checks: [],
      }),
      submitForReview: async () => 'submitted',
    },
    relay: {
      load: async () =>
        ({ epoch, head: git(['rev-parse', 'HEAD']) }) as Capsule,
      checkpoint: async () =>
        ({ epoch: ++epoch, head: git(['rev-parse', 'HEAD']) }) as Capsule,
      admitCommit: () => undefined,
      recordCommit: async (_job, sessionId, sha) =>
        ({ epoch: ++epoch, head: sha, sessionId }) as Capsule,
      bindSession: async (_job, capsule, _sessionId) => ({
        applied: true as const,
        value: { ...capsule, epoch: ++epoch, sessionId: _sessionId },
      }),
      isCurrent: async (_job, value) => value === epoch,
      repoFacts: async () => ({
        base: git(['rev-parse', 'HEAD']),
        head: git(['rev-parse', 'HEAD']),
        branch: 'main',
        worktree,
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
      checkpointRequest: async () => ({
        message: 'feat: step A',
        next: 'step B',
      }),
      commit: async () => undefined,
      commitIntent: async () => undefined,
      checkpointCommit: async () => null,
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
                await writeFile(join(worktree, 'step-a.txt'), 'completed\n');
                await d.trace.checkpoint(
                  job,
                  'intent-0',
                  id,
                  'feat: step A',
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
    outcome = await runJob(job, d);
  });
  assert.equal(checkpointed, true);
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0], sessions[1]);
  assert.deepEqual(actionSessions, [sessions[1]]);
  assert.deepEqual(outcome, {
    kind: 'stop',
    state: 'human_decision',
    reasons: ['no_progress'],
  });
});

test('a dead scoped session without an end record is recovered as session_lost', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  await new Promise<void>((resolve) => child.once('spawn', resolve));
  const sessionId = 'session-lost-fixture';
  const job = { id: 'lost-job', issue: 'I-LOST', worktree: process.cwd() };
  const capsule = {
    jobId: job.id,
    issue: job.issue,
    contractRevision: 'rev-1',
    epoch: 4,
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    branch: 'main',
    worktree: job.worktree,
    nextAction: 'continue work',
    lease: 'active' as const,
    sessionId,
    blockers: [],
    decisions: [],
    rejectedApproaches: [],
    references: [],
  };
  let recorded: readonly string[] | undefined;
  let scopeActive = true;
  let refreshed:
    | { reasonKind: string; dirtyPaths?: readonly string[] }
    | undefined;
  const d = {
    trace: {
      sessionEnd: async () => null,
      sessionIsolation: async () => 'systemd_scope' as const,
      sessionLost: async (
        _job: typeof job,
        _session: string,
        paths: readonly string[],
      ) => {
        recorded = paths;
      },
    },
    hosts: {
      sessionScopeActive: async () => scopeActive,
    },
    relay: {
      repoFacts: async () => ({
        base: capsule.base,
        head: capsule.head,
        branch: 'main',
        worktree: job.worktree,
        dirtyPaths: ['unfinished.ts'],
      }),
      refreshCAS: async (
        _capsule: typeof capsule,
        _facts: unknown,
        end: typeof refreshed,
      ) => {
        refreshed = end;
        return {
          applied: true as const,
          value: { ...capsule, epoch: 5, lease: 'ended' as const },
        };
      },
    },
    stop: (
      _job: typeof job,
      _state: 'human_decision',
      reasons: readonly string[],
    ) => ({
      kind: 'stop' as const,
      state: 'human_decision' as const,
      reasons,
    }),
  };
  const active = await recoverLease(job, capsule, d as never);
  assert.deepEqual(active.outcome, {
    kind: 'stop',
    state: 'human_decision',
    reasons: ['already running'],
  });
  const dead = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  child.kill('SIGKILL');
  await dead;
  scopeActive = false;
  const result = await recoverLease(job, capsule, d as never);
  assert.equal(result.outcome, undefined);
  assert.deepEqual(recorded, ['unfinished.ts']);
  assert.equal(refreshed?.reasonKind, 'session_lost');
  assert.deepEqual(refreshed?.dirtyPaths, ['unfinished.ts']);
  assert.equal(result.capsule.lease, 'ended');
});

test('live submission takes Krn-Session from the verified commit trailer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'krn-session-trailer-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(['init', '-q', '--initial-branch=main']);
    await writeFile(join(root, 'README.md'), 'fixture\n');
    git(['add', 'README.md']);
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'test: verified commit\n\nKrn-Session: trailer-session',
    ]);
    const sha = git(['rev-parse', 'HEAD']);
    const job = { id: 'session-job', issue: 'I-SESSION', worktree: root };
    let supplied: string | undefined;
    const result = await reportPassingVerdict(
      job,
      {
        issueId: job.issue,
        identifier: job.issue,
        title: 'test',
        description: 'test',
        revision: 'rev',
        targetRepo: 'fixture/repo',
        checks: [],
      },
      sha,
      [],
      {
        submissionEnabled: true,
        submitForReview: async (
          _job: typeof job,
          _contract: Contract,
          _evidence: VerdictEvidence,
          _sha: string,
          options?: SubmitForReviewOptions,
        ) => {
          supplied = options?.session;
          return 'submitted';
        },
      } as never,
      {},
      (_job, state, reasons) => ({ kind: 'stop', state, reasons }),
    );
    assert.equal(result.kind, 'verdict_pass');
    assert.equal(supplied, 'trailer-session');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    ledger: {
      readContract: async () => ({
        issueId: 'issue-active',
        identifier: 'issue-active',
        title: 'active fixture',
        description: 'active fixture',
        revision: 'rev-1',
        targetRepo: 'fixture/repo',
        checks: [],
      }),
      submitForReview: async () => 'submitted',
    },
    relay,
    trace: {
      intent: async (_job, epoch) => `intent-${epoch}`,
      started: async () => true,
      checkpoint: async () => undefined,
      checkpointRequest: async () => null,
      commit: async () => undefined,
      commitIntent: async () => undefined,
      checkpointCommit: async () => null,
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
