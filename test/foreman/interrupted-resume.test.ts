import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { finishCheckpoint } from '../../src/foreman/checkpoint.ts';
import { writeCheckpointRequest } from '../../src/foreman/checkpoint-request.ts';
import * as foreman from '../../src/foreman/index.ts';
import { runJob } from '../../src/foreman/run.ts';
import { recoverLease, runSession } from '../../src/foreman/session.ts';
import { recordRepo, stateDirectory } from '../../src/foreman/state.ts';
import type { Capsule, Deps, Outcome } from '../../src/foreman/types.ts';
import { reportPassingVerdict } from '../../src/foreman/verdict.ts';
import type {
  Contract,
  SubmitForReviewOptions,
  VerdictEvidence,
} from '../../src/ledger/index.ts';
import * as relay from '../../src/relay/index.ts';
import * as diskTrace from '../../src/trace/index.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

test('failed startup releases only the positively cancelled bound capsule lease', async () => {
  const scratch = join(process.cwd(), '.krn', 'tmp');
  await mkdir(scratch, { recursive: true });
  const worktree = await mkdtemp(join(scratch, 'startup-handback-'));
  let worker: ReturnType<typeof spawn> | undefined;
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', worktree, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(['init', '-q', '--initial-branch=main']);
    git(['config', 'user.name', 'Fixture']);
    git(['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(worktree, '.gitignore'), '.krn/\n');
    await writeFile(join(worktree, 'README.md'), 'fixture\n');
    git(['add', '.gitignore', 'README.md']);
    git(['commit', '-qm', 'fixture']);
    const job = {
      id: 'startup',
      issue: 'issue-startup',
      worktree,
      repoRoot: worktree,
    };
    const contract: Contract = {
      issueId: job.issue,
      identifier: 'startup',
      title: 'startup',
      description: 'startup',
      revision: 'rev-1',
      targetRepo: 'fixture/repo',
      checks: [],
    };
    recordRepo(job, worktree, 'main', git(['rev-parse', 'HEAD']));
    const capsule = await relay.load(job, contract);
    const d = {
      budget: { session: { timeoutMs: 1000 } },
      relay,
      trace: { started: async () => false },
      hosts: {
        codex: {
          start: async (input: {
            onStarted: (id: string) => Promise<boolean>;
          }) => {
            worker = spawn(
              process.execPath,
              ['-e', 'setInterval(() => {}, 1000)'],
              {
                stdio: 'ignore',
              },
            );
            await new Promise<void>((resolve, reject) => {
              worker?.once('spawn', () => resolve());
              worker?.once('error', reject);
            });
            const id = 'session-startup';
            try {
              await input.onStarted(id);
              throw new Error('fixture expected onStarted rejection');
            } catch (error) {
              const stopped = new Promise<void>((resolve) =>
                worker?.once('close', () => resolve()),
              );
              worker?.kill('SIGKILL');
              await stopped;
              const acknowledgement = Reflect.get(input, 'onStartCancelled');
              if (typeof acknowledgement === 'function')
                await acknowledgement(id);
              throw error;
            }
          },
        },
      },
    } as unknown as Deps;
    const facts = relay.repoFacts(job, capsule.base);
    await assert.rejects(
      runSession(job, capsule, facts, contract, 'intent:0', d),
      /already running/,
    );
    const after = await relay.load(job, contract);
    assert.equal(after.lease, 'ended');
    assert.equal(after.sessionId, undefined);
    assert.equal(after.epoch, capsule.epoch + 2);
    const retained = (value: Capsule) => ({
      jobId: value.jobId,
      issue: value.issue,
      contractRevision: value.contractRevision,
      base: value.base,
      head: value.head,
      branch: value.branch,
      worktree: value.worktree,
      nextAction: value.nextAction,
      blockers: value.blockers,
      decisions: value.decisions,
      rejectedApproaches: value.rejectedApproaches,
      references: value.references,
      pendingCheckpoint: value.pendingCheckpoint,
    });
    assert.deepEqual(retained(after), retained(capsule));
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      worker.kill('SIGKILL');
      await new Promise<void>((resolve) =>
        worker?.once('close', () => resolve()),
      );
    }
    await rm(worktree, { recursive: true, force: true });
  }
});

test('startup lease handback refuses a different owner, epoch, or lease state', async () => {
  const f = await partialCheckpointFixture();
  try {
    const active = await relay.load(f.job, f.contract);
    assert.ok(active.sessionId);
    assert.deepEqual(
      await relay.releaseStartupLease(f.job, active, 'foreign-session'),
      { applied: false },
    );
    assert.deepEqual(await relay.load(f.job, f.contract), active);
    assert.deepEqual(
      await relay.releaseStartupLease(
        f.job,
        { ...active, epoch: active.epoch - 1 },
        active.sessionId,
      ),
      { applied: false },
    );
    assert.deepEqual(await relay.load(f.job, f.contract), active);

    const ended = {
      ...active,
      epoch: active.epoch + 1,
      lease: 'ended' as const,
      sessionId: undefined,
    };
    const saved = await relay.writeCapsule(f.job, ended, active.epoch);
    assert.equal(saved.applied, true);
    assert.deepEqual(
      await relay.releaseStartupLease(f.job, ended, active.sessionId),
      { applied: false },
    );
    assert.deepEqual(
      { ...(await relay.load(f.job, f.contract)), sessionId: undefined },
      ended,
    );
  } finally {
    await rm(f.worktree, { recursive: true, force: true });
  }
});

test('startup rejection without a successful bind preserves the existing owner', async () => {
  const f = await partialCheckpointFixture();
  let worker: ReturnType<typeof spawn> | undefined;
  try {
    const before = await relay.load(f.job, f.contract);
    const d: Deps = {
      ...f.d,
      hosts: {
        ...f.d.hosts,
        codex: {
          start: async (input) => {
            worker = spawn(
              process.execPath,
              ['-e', 'setInterval(() => {}, 1000)'],
              {
                stdio: 'ignore',
              },
            );
            await new Promise<void>((resolve, reject) => {
              worker?.once('spawn', () => resolve());
              worker?.once('error', reject);
            });
            const id = 'foreign-startup-session';
            try {
              await input.onStarted(id);
              throw new Error('fixture expected active owner refusal');
            } catch (error) {
              const stopped = new Promise<void>((resolve) =>
                worker?.once('close', () => resolve()),
              );
              worker?.kill('SIGKILL');
              await stopped;
              await input.onStartCancelled?.(id);
              throw error;
            }
          },
        },
      },
    };
    const facts = relay.repoFacts(f.job, before.base);
    await assert.rejects(
      runSession(f.job, before, facts, f.contract, 'intent:foreign', d),
      /already running/,
    );
    assert.deepEqual(await relay.load(f.job, f.contract), before);
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      worker.kill('SIGKILL');
      await new Promise<void>((resolve) =>
        worker?.once('close', () => resolve()),
      );
    }
    await rm(f.worktree, { recursive: true, force: true });
  }
});

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
      recordCommit: async (_job, sessionId, sha) =>
        ({ epoch: ++epoch, head: sha, sessionId }) as Capsule,
      bindSession: async (_job, capsule, _sessionId) => ({
        applied: true as const,
        value: { ...capsule, epoch: ++epoch, sessionId: _sessionId },
      }),
      releaseStartupLease: async () => ({ applied: false as const }),
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
        // Trace appends events; only the relay advances the capsule epoch.
      },
      checkpointRequest: async () => ({
        message: 'feat: step A',
        next: 'step B',
      }),
      commit: async () => undefined,
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
  let registration: unknown;
  let scopeActive: boolean | null = true;
  let refreshed:
    | { reasonKind: string; dirtyPaths?: readonly string[] }
    | undefined;
  const d = {
    trace: {
      sessionEnd: async () => null,
      sessionIsolation: async () => 'systemd_scope' as const,
      sessionScopeRegistration: async () => registration,
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
  const legacy = await recoverLease(job, capsule, d as never);
  assert.deepEqual(legacy.outcome, {
    kind: 'stop',
    state: 'human_decision',
    reasons: ['already running'],
  });
  registration = {
    unit: 'krn-lost-job-session-lost-fixture.scope',
    controlGroup:
      '/user.slice/user-1000.slice/user@1000.service/app.slice/krn-lost-job-session-lost-fixture.scope',
    pid: child.pid,
    startTicks: '12345',
  };
  scopeActive = null;
  const unknown = await recoverLease(job, capsule, d as never);
  assert.deepEqual(unknown.outcome, {
    kind: 'stop',
    state: 'human_decision',
    reasons: ['already running'],
  });
  assert.equal(
    Boolean(recorded),
    false,
    'unknown scope status must not record session_lost',
  );
  assert.equal(
    Boolean(refreshed),
    false,
    'unknown scope status must not advance recovery CAS',
  );
  scopeActive = false;
  const result = await recoverLease(job, capsule, d as never);
  assert.equal(result.outcome, undefined);
  assert.deepEqual(recorded, ['unfinished.ts']);
  assert.equal(refreshed?.reasonKind, 'session_lost');
  assert.deepEqual(refreshed?.dirtyPaths, ['unfinished.ts']);
  assert.equal(result.capsule.lease, 'ended');
});

test('legacy persisted scoped session without registration proof stays already running', async () => {
  const scratch = join(process.cwd(), '.krn', 'tmp');
  await mkdir(scratch, { recursive: true });
  const worktree = await mkdtemp(join(scratch, 'legacy-scope-proof-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', worktree, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(['init', '-q', '--initial-branch=main']);
    git(['config', 'user.name', 'Fixture']);
    git(['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(worktree, '.gitignore'), '.krn/\n');
    await writeFile(join(worktree, 'README.md'), 'fixture\n');
    git(['add', '.gitignore', 'README.md']);
    git(['commit', '-qm', 'fixture']);
    const job = {
      id: 'legacy-scope',
      issue: 'issue-legacy-scope',
      worktree,
      repoRoot: worktree,
    };
    const contract: Contract = {
      issueId: job.issue,
      identifier: 'legacy-scope',
      title: 'legacy scope',
      description: 'legacy scope',
      revision: 'rev-1',
      targetRepo: 'fixture/repo',
      checks: [],
    };
    recordRepo(job, worktree, 'main', git(['rev-parse', 'HEAD']));
    const initial = await relay.load(job, contract);
    const intent = await diskTrace.intent(job, initial.epoch);
    const sessionId = 'legacy-session';
    const bound = await relay.bindSession(job, initial, sessionId);
    assert.equal(bound.applied, true);
    if (!bound.applied) throw new Error('fixture bind failed');
    await appendFile(
      join(stateDirectory(job), 'trace.jsonl'),
      `${JSON.stringify({
        id: 'legacy-session-start',
        key: `${intent}:session`,
        kind: 'session_started',
        at: new Date().toISOString(),
        data: {
          intent,
          sessionId,
          sandbox: 'workspace-write',
          isolation: 'systemd_scope',
        },
      })}\n`,
    );
    let observerCalls = 0;
    const d = {
      relay,
      trace: diskTrace,
      hosts: {
        sessionScopeActive: () => {
          observerCalls += 1;
          return false;
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
    const result = await recoverLease(job, bound.value, d as never);
    assert.deepEqual(result.outcome, {
      kind: 'stop',
      state: 'human_decision',
      reasons: ['already running'],
    });
    assert.deepEqual(await relay.load(job, contract), bound.value);
    assert.equal(
      observerCalls,
      0,
      'legacy data must not authorize a negative-scope observer',
    );
    const tracePath = join(stateDirectory(job), 'trace.jsonl');
    const events = (await readFile(tracePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const started = events.find((event) => event.kind === 'session_started');
    assert.ok(started);
    started.data.jobId = job.id;
    started.data.scopeRegistration = {
      unit: 'krn-foreign.scope',
      controlGroup: '/user.slice/krn-foreign.scope',
      pid: process.pid,
      startTicks: 'not-a-process-identity',
    };
    await writeFile(
      tracePath,
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    );
    const malformed = await recoverLease(job, bound.value, d as never);
    assert.deepEqual(malformed.outcome, {
      kind: 'stop',
      state: 'human_decision',
      reasons: ['already running'],
    });
    assert.equal(
      observerCalls,
      0,
      'malformed persisted proof must remain unusable',
    );
    assert.deepEqual(await relay.load(job, contract), bound.value);
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
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

async function conditionWithin(read: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while (!read() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  return read();
}

// Batch02 exercises the real checkpoint, relay and trace against disk/Git.
async function partialCheckpointFixture(
  next = 'step B',
  check = '/usr/bin/true',
  message = 'feat: checkpoint step',
) {
  const scratch = join(process.cwd(), '.krn', 'tmp');
  await mkdir(scratch, { recursive: true });
  const worktree = await mkdtemp(join(scratch, 'partial-checkpoint-'));
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
      checks: [{ id: 'declared', argv: [check], timeoutMs: 3000 }],
    }),
  );
  git(['add', '.gitignore', 'krn.checks.json']);
  git(['commit', '-qm', 'fixture']);
  const job = {
    id: 'partial',
    issue: 'issue-partial',
    worktree,
    repoRoot: worktree,
  };
  const contract: Contract = {
    issueId: job.issue,
    identifier: 'partial',
    title: 'partial',
    description: 'partial',
    revision: 'rev-1',
    targetRepo: 'fixture/repo',
    checks: ['declared'],
  };
  recordRepo(job, worktree, 'main', git(['rev-parse', 'HEAD']));
  const initial = await relay.load(job, contract);
  const intent = await diskTrace.intent(job, initial.epoch);
  const bound = await relay.bindSession(job, initial, 'session-partial');
  assert.equal(bound.applied, true);
  if (!bound.applied) throw new Error('fixture bind failed');
  await diskTrace.started(job, intent, 'session-partial');
  writeCheckpointRequest(job, {
    intent,
    sessionId: 'session-partial',
    message,
    next,
  });
  await writeFile(join(worktree, 'change.txt'), 'worker change\n');
  let starts = 0;
  const d: Deps = {
    budget: { maxResets: 0, maxRepairs: 0, session: { timeoutMs: 1000 } },
    ledger: {
      submissionEnabled: false,
      readContract: async () => contract,
      submitForReview: async () => 'ready_for_review',
    },
    relay,
    trace: diskTrace,
    hosts: {
      codex: {
        start: async () => {
          starts++;
          throw new Error('fake backend reached next action');
        },
      },
      cancelTree: async () => undefined,
    },
    stop: (_job, state, reasons) => ({ kind: 'stop', state, reasons }),
  };
  return {
    worktree,
    job,
    contract,
    intent,
    capsule: bound.value,
    d,
    git,
    starts: () => starts,
  };
}

for (const boundary of [
  'before trace.commit',
  'before recordCommit',
] as const) {
  test(`partial checkpoint recovers ${boundary} without another commit`, async () => {
    const f = await partialCheckpointFixture();
    try {
      const interrupted: Deps = {
        ...f.d,
        trace:
          boundary === 'before trace.commit'
            ? {
                ...diskTrace,
                commit: async () => {
                  throw new Error('injected interruption');
                },
              }
            : diskTrace,
        relay:
          boundary === 'before recordCommit'
            ? {
                ...relay,
                recordCommit: async () => {
                  throw new Error('injected interruption');
                },
              }
            : relay,
      };
      await assert.rejects(
        finishCheckpoint(f.job, f.capsule, f.intent, interrupted),
        /injected interruption/,
      );
      const head = f.git(['rev-parse', 'HEAD']);
      assert.notEqual(
        head,
        f.capsule.head,
        'injection must follow the actual commit',
      );
      const resumedOutcome = await runJob(f.job, f.d);
      const recovered = await relay.load(f.job, f.contract);
      assert.equal(
        recovered.head,
        head,
        `resume must reconcile the owned checkpoint: ${JSON.stringify(resumedOutcome)}`,
      );
      assert.equal(recovered.nextAction, 'step B');
      assert.equal(f.starts(), 1, 'continue reaches the next worker action');
      await runJob(f.job, f.d);
      assert.equal(f.git(['rev-list', '--count', 'HEAD']), '2');
      const events = (
        await readFile(
          join(f.worktree, '.krn/runs/foreman/partial/trace.jsonl'),
          'utf8',
        )
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(events.filter((event) => event.kind === 'commit').length, 1);
    } finally {
      await rm(f.worktree, { recursive: true, force: true });
    }
  });
}

for (const bound of ['history', 'projection'] as const) {
  test(`checkpoint preflights completed capsule ${bound} before changing HEAD`, async () => {
    const f = await partialCheckpointFixture();
    try {
      let full = {
        ...f.capsule,
        epoch: f.capsule.epoch + 1,
        decisions:
          bound === 'history'
            ? Array.from({ length: 63 }, () => ({
                date: 'd',
                source: 's',
                text: 'x',
              }))
            : [],
        references: bound === 'projection' ? ['x'.repeat(6300)] : [],
      };
      // ABI is fixed at 8000 characters. Leave room for the request decision,
      // but not for the additional foreman commit decision (no history trimming).
      if (bound === 'projection') {
        const projection = await readFile(
          join(f.worktree, '.krn/runs/delivery-loop/partial/state.md'),
          'utf8',
        );
        full = {
          ...full,
          references: ['x'.repeat(7860 - projection.length - 2)],
        };
      }
      const saved = await relay.writeCapsule(f.job, full, f.capsule.epoch);
      assert.equal(saved.applied, true, 'capacity fixture must persist');
      const before = f.git(['rev-parse', 'HEAD']);
      await assert.rejects(finishCheckpoint(f.job, full, f.intent, f.d));
      assert.equal(
        f.git(['rev-parse', 'HEAD']),
        before,
        'deterministic capsule refusal must precede HEAD change',
      );
    } finally {
      await rm(f.worktree, { recursive: true, force: true });
    }
  });
}

for (const check of ['/usr/bin/true', '/usr/bin/false']) {
  test(`recovered done checkpoint runs required verification (${check})`, async (t) => {
    if (
      !requiresIsolation(
        t,
        'recovered done checkpoint runs required verification',
        ['bwrap', 'systemdUserScope'],
      )
    )
      return;
    const f = await partialCheckpointFixture('done', check);
    try {
      await assert.rejects(
        finishCheckpoint(f.job, f.capsule, f.intent, {
          ...f.d,
          trace: {
            ...diskTrace,
            commit: async () => {
              throw new Error('injected interruption');
            },
          },
        }),
        /injected interruption/,
      );
      const head = f.git(['rev-parse', 'HEAD']);
      for (let attempt = 0; attempt < 2; attempt++) {
        const outcome = await runJob(f.job, f.d);
        assert.equal(
          outcome.kind,
          check === '/usr/bin/true' ? 'verdict_pass' : 'stop',
          JSON.stringify(outcome),
        );
        assert.equal(f.starts(), 0, 'done must reach verdict without a worker');
        assert.equal(f.git(['rev-parse', 'HEAD']), head);
        assert.equal(f.git(['rev-list', '--count', 'HEAD']), '2');
      }
      const events = (
        await readFile(
          join(f.worktree, '.krn/runs/foreman/partial/trace.jsonl'),
          'utf8',
        )
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const verdicts = events.filter((event) => event.kind === 'verdict');
      assert.ok(verdicts.length > 0, 'required verifier executed');
      assert.equal(
        verdicts[0].data.checks[0].exitCode,
        check === '/usr/bin/true' ? 0 : 1,
      );
    } finally {
      await rm(f.worktree, { recursive: true, force: true });
    }
  });
}

// Worker messages are stored verbatim; leading whitespace must not strand pending state.
for (const message of [' feat: leading space', '\tfeat: leading tab']) {
  for (const boundary of [
    'before trace.commit',
    'before publication',
  ] as const) {
    test(`partial checkpoint with ${JSON.stringify(message)} recovers ${boundary}`, async () => {
      const f = await partialCheckpointFixture(
        'step B',
        '/usr/bin/true',
        message,
      );
      try {
        const interruption = await finishCheckpoint(
          f.job,
          f.capsule,
          f.intent,
          {
            ...f.d,
            trace: {
              ...diskTrace,
              ...(boundary === 'before trace.commit'
                ? {
                    commit: async () => {
                      throw new Error('injected interruption');
                    },
                  }
                : {
                    checkpoint: async () => {
                      throw new Error('injected interruption');
                    },
                  }),
            },
          },
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        assert.match(String(interruption), /injected interruption/);
        const pending = (await relay.load(f.job, f.contract)).pendingCheckpoint;
        assert.ok(pending);
        await runJob(f.job, f.d);
        const recovered = await relay.load(f.job, f.contract);
        assert.equal(recovered.pendingCheckpoint, undefined);
        assert.equal(recovered.head, pending.sha);
        assert.equal(f.git(['rev-parse', 'HEAD']), pending.sha);
        assert.equal(f.starts(), 1, 'continue reaches the next worker action');
        const body = f.git(['cat-file', 'commit', pending.sha]);
        assert.equal(
          body.slice(body.indexOf('\n\n') + 2),
          `${message}\n\nKrn-Session: session-partial`,
        );
        await runJob(f.job, f.d);
        assert.equal(f.git(['rev-list', '--count', 'HEAD']), '2');
        const events = (
          await readFile(
            join(f.worktree, '.krn/runs/foreman/partial/trace.jsonl'),
            'utf8',
          )
        )
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        assert.deepEqual(
          events
            .filter((event) => event.kind === 'commit')
            .map((event) => event.data.sha),
          [pending.sha],
        );
      } finally {
        await rm(f.worktree, { recursive: true, force: true });
      }
    });
  }
}

test('pending checkpoint resumes after capsule CAS but before HEAD publication', async () => {
  const f = await partialCheckpointFixture();
  try {
    await assert.rejects(
      finishCheckpoint(f.job, f.capsule, f.intent, {
        ...f.d,
        trace: {
          ...diskTrace,
          checkpoint: async () => {
            throw new Error('injected before publication');
          },
        },
      }),
      /injected before publication/,
    );
    assert.equal(f.git(['rev-parse', 'HEAD']), f.capsule.head);
    const pending = await relay.load(f.job, f.contract);
    assert.ok(pending.pendingCheckpoint);
    await runJob(f.job, f.d);
    assert.equal(
      (await relay.load(f.job, f.contract)).head,
      pending.pendingCheckpoint.sha,
    );
    assert.equal(f.git(['rev-list', '--count', 'HEAD']), '2');
  } finally {
    await rm(f.worktree, { recursive: true, force: true });
  }
});

for (const mutation of [
  'foreign HEAD',
  'foreign sibling',
  'wrong parent',
  'wrong session',
  'wrong intent',
  'stale epoch',
  'contract',
  'branch',
  'legacy ambiguity',
  'CAS lock',
] as const) {
  test(`partial checkpoint fails closed on ${mutation}`, async () => {
    const f = await partialCheckpointFixture();
    try {
      await assert.rejects(
        finishCheckpoint(f.job, f.capsule, f.intent, {
          ...f.d,
          trace: {
            ...diskTrace,
            commit: async () => {
              throw new Error('injected interruption');
            },
          },
        }),
        /injected interruption/,
      );
      const owned = await relay.load(f.job, f.contract);
      const pending = owned.pendingCheckpoint;
      assert.ok(pending);
      const path = join(f.worktree, '.krn/runs/foreman/partial/capsule.json');
      if (mutation === 'foreign HEAD') {
        // Even the correct session/message is insufficient without the exact prepared object.
        f.git([
          'commit',
          '--allow-empty',
          '-qm',
          'feat: checkpoint step\n\nKrn-Session: session-partial',
        ]);
      } else if (mutation === 'foreign sibling') {
        await writeFile(join(f.worktree, 'foreign.txt'), 'foreign tree\n');
        f.git(['add', 'foreign.txt']);
        const sibling = f.git([
          'commit-tree',
          f.git(['write-tree']),
          '-p',
          f.capsule.head,
          '-m',
          'feat: checkpoint step\n\nKrn-Session: session-partial',
        ]);
        f.git(['update-ref', 'HEAD', sibling, pending.sha]);
      } else if (mutation === 'branch') f.git(['checkout', '-qb', 'foreign']);
      else if (mutation === 'CAS lock')
        await writeFile(`${path}.lock`, `${process.pid}\n`);
      else if (mutation === 'contract') {
        await writeFile(
          path,
          JSON.stringify({ ...owned, contractRevision: 'foreign' }),
        );
      } else {
        const changed = {
          ...owned,
          ...(mutation === 'wrong session'
            ? { sessionId: 'foreign-session' }
            : {}),
          ...(mutation === 'wrong parent'
            ? { head: f.git(['rev-parse', 'HEAD']) }
            : {}),
          ...(mutation === 'stale epoch' ? { epoch: owned.epoch + 1 } : {}),
          ...(mutation === 'wrong intent'
            ? { pendingCheckpoint: { ...pending, intent: 'intent:999' } }
            : {}),
          ...(mutation === 'legacy ambiguity'
            ? { pendingCheckpoint: undefined }
            : {}),
        };
        await writeFile(path, JSON.stringify(changed));
      }
      const before = await readFile(path, 'utf8');
      const head = f.git(['rev-parse', 'HEAD']);
      if (mutation === 'contract')
        await assert.rejects(runJob(f.job, f.d), /contract revision is stale/);
      else {
        const outcome = await runJob(f.job, f.d);
        assert.equal(outcome.kind, 'stop', JSON.stringify(outcome));
        if (outcome.kind === 'stop') assert.ok(outcome.reasons.length > 0);
      }
      assert.equal(f.starts(), 0, 'ambiguous ownership cannot start a worker');
      assert.equal(
        await readFile(path, 'utf8'),
        before,
        'no overwrite on refusal',
      );
      assert.equal(
        f.git(['rev-parse', 'HEAD']),
        head,
        'no new commit on refusal',
      );
    } finally {
      await rm(f.worktree, { recursive: true, force: true });
    }
  });
}

test('checkpoint publication refuses ownership changed while recording trace', async () => {
  const f = await partialCheckpointFixture();
  try {
    await assert.rejects(
      finishCheckpoint(f.job, f.capsule, f.intent, {
        ...f.d,
        trace: {
          ...diskTrace,
          checkpoint: async (...args) => {
            await diskTrace.checkpoint(...args);
            const current = await relay.load(f.job, f.contract);
            assert.equal(
              (
                await relay.writeCapsule(
                  f.job,
                  { ...current, epoch: current.epoch + 1 },
                  current.epoch,
                )
              ).applied,
              true,
            );
          },
        },
      }),
      /ownership changed/,
    );
    assert.equal(f.git(['rev-parse', 'HEAD']), f.capsule.head);
  } finally {
    await rm(f.worktree, { recursive: true, force: true });
  }
});

async function endPartialFixtureLease(
  f: Awaited<ReturnType<typeof partialCheckpointFixture>>,
): Promise<Capsule> {
  const current = await relay.load(f.job, f.contract);
  const ended = {
    ...current,
    epoch: current.epoch + 1,
    lease: 'ended' as const,
    sessionId: undefined,
  };
  const saved = await relay.writeCapsule(f.job, ended, current.epoch);
  assert.equal(saved.applied, true, 'fixture lease must be released by CAS');
  if (!saved.applied) throw new Error('fixture lease release CAS failed');
  return saved.value;
}

test('an abort before an ordinary step creates no intent or session; live control still enters both', async () => {
  for (const aborted of [false, true]) {
    const f = await partialCheckpointFixture();
    try {
      const capsule = await endPartialFixtureLease(f);
      const controller = new AbortController();
      if (aborted) controller.abort('test abort');
      let intents = 0;
      let starts = 0;
      const d: Deps = {
        ...f.d,
        signal: controller.signal,
        trace: {
          ...diskTrace,
          intent: async (job, epoch) => {
            intents += 1;
            return diskTrace.intent(job, epoch);
          },
        },
        hosts: {
          ...f.d.hosts,
          codex: {
            start: async () => {
              starts += 1;
              throw new Error('controlled host-start boundary');
            },
          },
        },
      };
      const outcome = await runJob(f.job, d);
      assert.equal(outcome.kind, 'stop');
      assert.deepEqual(
        { intents, starts },
        aborted ? { intents: 0, starts: 0 } : { intents: 1, starts: 1 },
        'intent and host start must follow the abort fence',
      );
      assert.equal((await relay.load(f.job, f.contract)).epoch, capsule.epoch);
    } finally {
      await rm(f.worktree, { recursive: true, force: true });
    }
  }
});

test('an entry abort recovers a durable pending checkpoint before stopping without a worker', async () => {
  const f = await partialCheckpointFixture();
  try {
    await assert.rejects(
      finishCheckpoint(f.job, f.capsule, f.intent, {
        ...f.d,
        trace: {
          ...diskTrace,
          commit: async () => {
            throw new Error('injected after checkpoint publication');
          },
        },
      }),
      /injected after checkpoint publication/,
    );
    const pending = (await relay.load(f.job, f.contract)).pendingCheckpoint;
    assert.ok(pending, 'fixture must begin with a durable pending checkpoint');

    const controller = new AbortController();
    controller.abort('test abort');
    const outcome = await runJob(f.job, { ...f.d, signal: controller.signal });
    const recovered = await relay.load(f.job, f.contract);
    assert.equal(outcome.kind, 'stop');
    assert.equal(f.starts(), 0, 'recovery must not start the next worker');
    assert.equal(recovered.pendingCheckpoint, undefined);
    assert.equal(recovered.head, pending.sha);
    assert.equal(f.git(['rev-parse', 'HEAD']), pending.sha);
  } finally {
    await rm(f.worktree, { recursive: true, force: true });
  }
});

test('an abort before checkpoint entry preserves dirty work and records the ended lease', async () => {
  const f = await partialCheckpointFixture();
  try {
    await endPartialFixtureLease(f);
    const controller = new AbortController();
    const before = f.git(['rev-parse', 'HEAD']);
    let starts = 0;
    let checkpointEntered = false;
    const d: Deps = {
      ...f.d,
      signal: controller.signal,
      trace: {
        ...diskTrace,
        checkpoint: async (...args) => {
          checkpointEntered = true;
          await diskTrace.checkpoint(...args);
        },
      },
      hosts: {
        ...f.d.hosts,
        codex: {
          start: async (input) => {
            starts += 1;
            const id = 'abort-before-checkpoint-session';
            assert.equal(await input.onStarted(id), true);
            writeCheckpointRequest(f.job, {
              intent: input.checkpoint.intent,
              sessionId: id,
              message: 'feat: must not checkpoint after abort',
              next: 'step B',
            });
            return {
              id,
              wait: async () => {
                controller.abort('test abort before checkpoint entry');
                return { reasonKind: 'interrupted', claimsDone: false };
              },
            };
          },
        },
      },
    };

    const outcome = await runJob(f.job, d);
    const stopped = await relay.load(f.job, f.contract);
    const facts = relay.repoFacts(f.job, stopped.base);
    assert.equal(outcome.kind, 'stop');
    assert.equal(
      f.git(['rev-parse', 'HEAD']),
      before,
      'abort must not create a commit',
    );
    assert.deepEqual(facts.dirtyPaths, ['change.txt']);
    assert.deepEqual(stopped.blockers, [
      'uncommitted_changes: reasonKind=interrupted; path=change.txt',
    ]);
    assert.match(
      await readFile(
        join(f.worktree, '.krn/runs/foreman/partial/trace.jsonl'),
        'utf8',
      ),
      /"kind":"session_ended".*"reasonKind":"interrupted"/u,
    );
    if (outcome.kind === 'stop')
      assert.deepEqual(outcome.reasons, [
        'uncommitted_changes: reasonKind=interrupted; paths=change.txt',
      ]);
    assert.equal(stopped.lease, 'ended');
    assert.equal(stopped.sessionId, undefined);
    assert.equal(stopped.pendingCheckpoint, undefined);
    assert.equal(
      checkpointEntered,
      false,
      'abort must not enter a new checkpoint',
    );
    assert.equal(starts, 1, 'abort must prevent another worker');
  } finally {
    await rm(f.worktree, { recursive: true, force: true });
  }
});

test('abort between checkpoint request validation and transaction entry prevents a fresh commit', async () => {
  const f = await partialCheckpointFixture();
  try {
    await endPartialFixtureLease(f);
    const controller = new AbortController();
    const before = f.git(['rev-parse', 'HEAD']);
    let abortRan = false;
    let requestWasReturned = false;
    let checkpointCalls = 0;
    let checkpointSawAbort = false;
    const d: Deps = {
      ...f.d,
      signal: controller.signal,
      trace: {
        ...diskTrace,
        checkpointRequest: async (...args) => {
          const request = await diskTrace.checkpointRequest(...args);
          requestWasReturned = request !== null;
          // A runs before the outer wrapper's continuation; B runs after its
          // signal check but before finishCheckpoint resumes from its await.
          queueMicrotask(() => {
            queueMicrotask(() => {
              abortRan = true;
              controller.abort('abort between request check and transaction');
            });
          });
          return request;
        },
      },
      relay: {
        ...f.d.relay,
        checkpoint: async (...args) => {
          checkpointCalls += 1;
          checkpointSawAbort = controller.signal.aborted;
          return relay.checkpoint(...args);
        },
      },
      hosts: {
        ...f.d.hosts,
        codex: {
          start: async (input) => {
            const id = 'abort-checkpoint-entry-session';
            assert.equal(await input.onStarted(id), true);
            writeCheckpointRequest(f.job, {
              intent: input.checkpoint.intent,
              sessionId: id,
              message: 'feat: abort checkpoint entry',
              next: 'step B',
            });
            return {
              id,
              wait: async () => ({
                reasonKind: 'interrupted',
                claimsDone: false,
              }),
            };
          },
        },
      },
    };

    const outcome = await runJob(f.job, d);
    const after = await relay.load(f.job, f.contract);
    const facts = relay.repoFacts(f.job, after.base);
    assert.equal(outcome.kind, 'stop');
    assert.equal(abortRan, true, 'the queued abort must execute');
    assert.equal(
      requestWasReturned,
      true,
      'use the persisted current-session request',
    );
    assert.equal(
      checkpointCalls === 0 || checkpointSawAbort,
      true,
      'any fresh relay checkpoint entry must observe the abort state',
    );
    assert.deepEqual(
      {
        checkpointCalls,
        head: f.git(['rev-parse', 'HEAD']),
        dirtyPaths: facts.dirtyPaths,
        lease: after.lease,
        sessionId: after.sessionId,
        blockers: after.blockers,
      },
      {
        checkpointCalls: 0,
        head: before,
        dirtyPaths: ['change.txt'],
        lease: 'ended',
        sessionId: undefined,
        blockers: [
          'uncommitted_changes: reasonKind=interrupted; path=change.txt',
        ],
      },
      'abort after request validation must fence prepare/relay checkpoint entry and preserve dirty facts',
    );
  } finally {
    await rm(f.worktree, { recursive: true, force: true });
  }
});

test('an abort after checkpoint transaction entry finishes its owned commit but starts no next worker', async () => {
  const f = await partialCheckpointFixture();
  try {
    await endPartialFixtureLease(f);
    const controller = new AbortController();
    const before = f.git(['rev-parse', 'HEAD']);
    let starts = 0;
    let checkpointEntered = false;
    const d: Deps = {
      ...f.d,
      budget: { ...f.d.budget, maxResets: 1 },
      signal: controller.signal,
      trace: {
        ...diskTrace,
        checkpoint: async (...args) => {
          await diskTrace.checkpoint(...args);
          checkpointEntered = true;
          controller.abort('test abort inside checkpoint transaction');
        },
      },
      hosts: {
        ...f.d.hosts,
        codex: {
          start: async (input) => {
            starts += 1;
            if (starts > 1) throw new Error('unexpected next worker');
            const id = 'abort-during-checkpoint-session';
            assert.equal(await input.onStarted(id), true);
            writeCheckpointRequest(f.job, {
              intent: input.checkpoint.intent,
              sessionId: id,
              message: 'feat: finish entered checkpoint',
              next: 'step B',
            });
            return {
              id,
              wait: async () => ({ reasonKind: 'exit', claimsDone: false }),
            };
          },
        },
      },
    };

    const outcome = await runJob(f.job, d);
    const completed = await relay.load(f.job, f.contract);
    assert.equal(outcome.kind, 'stop');
    assert.equal(
      checkpointEntered,
      true,
      'test must reach the entered transaction hook',
    );
    assert.notEqual(f.git(['rev-parse', 'HEAD']), before);
    assert.equal(completed.head, f.git(['rev-parse', 'HEAD']));
    assert.equal(completed.pendingCheckpoint, undefined);
    assert.equal(completed.lease, 'checkpointed');
    assert.equal(
      starts,
      1,
      'completed transaction must not start another worker',
    );
  } finally {
    await rm(f.worktree, { recursive: true, force: true });
  }
});

test('abort while a session is active awaits foreman-owned cleanup and preserves dirty work', async () => {
  const f = await partialCheckpointFixture();
  let releaseCleanup!: () => void;
  let releaseSession!: () => void;
  let running: Promise<Outcome> | undefined;
  try {
    await endPartialFixtureLease(f);
    const controller = new AbortController();
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const sessionGate = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    let waitEntered = false;
    let cleanupComplete = false;
    let cancelCalls = 0;
    let settled = false;
    const d: Deps = {
      ...f.d,
      signal: controller.signal,
      hosts: {
        ...f.d.hosts,
        codex: {
          start: async (input) => {
            const id = 'active-abort-session';
            assert.equal(await input.onStarted(id), true);
            return {
              id,
              wait: async () => {
                waitEntered = true;
                await sessionGate;
                return { reasonKind: 'interrupted', claimsDone: false };
              },
            };
          },
        },
        cancelTree: async (sessionId) => {
          assert.equal(sessionId, 'active-abort-session');
          cancelCalls += 1;
          await cleanupGate;
          cleanupComplete = true;
          releaseSession();
        },
      },
    };

    const before = f.git(['rev-parse', 'HEAD']);
    running = runJob(f.job, d);
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    assert.equal(
      await conditionWithin(() => waitEntered),
      true,
      'session must reach its owned wait before abort',
    );
    controller.abort('test abort during active session');
    assert.equal(
      await conditionWithin(() => cancelCalls > 0),
      true,
      'foreman must cancel the active owned session',
    );
    assert.equal(settled, false, 'foreman must await physical cleanup');
    assert.equal((await relay.load(f.job, f.contract)).lease, 'active');
    releaseCleanup();
    const outcome = await running;
    const stopped = await relay.load(f.job, f.contract);
    assert.equal(outcome.kind, 'stop');
    assert.equal(cancelCalls, 1);
    assert.equal(cleanupComplete, true);
    assert.equal(f.git(['rev-parse', 'HEAD']), before);
    assert.deepEqual(relay.repoFacts(f.job, stopped.base).dirtyPaths, [
      'change.txt',
    ]);
    assert.deepEqual(stopped.blockers, [
      'uncommitted_changes: reasonKind=interrupted; path=change.txt',
    ]);
    assert.match(
      await readFile(
        join(f.worktree, '.krn/runs/foreman/partial/trace.jsonl'),
        'utf8',
      ),
      /"kind":"session_ended".*"reasonKind":"interrupted"/u,
    );
    if (outcome.kind === 'stop')
      assert.deepEqual(outcome.reasons, [
        'uncommitted_changes: reasonKind=interrupted; paths=change.txt',
      ]);
    assert.equal(stopped.lease, 'ended');
    assert.equal(stopped.sessionId, undefined);
  } finally {
    releaseCleanup?.();
    releaseSession?.();
    await running?.catch(() => undefined);
    await rm(f.worktree, { recursive: true, force: true });
  }
});

test('abort during async startup trace cancels, waits for cleanup, then CAS-hands back before prompt eligibility', async () => {
  const f = await partialCheckpointFixture();
  let releaseTrace!: () => void;
  let releaseCleanup!: () => void;
  let running: Promise<Outcome> | undefined;
  try {
    await endPartialFixtureLease(f);
    const controller = new AbortController();
    const traceGate = new Promise<void>((resolve) => {
      releaseTrace = resolve;
    });
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupComplete = false;
    let traceCallbackEntered = false;
    const cleanupDone = cleanupGate.then(() => {
      cleanupComplete = true;
    });
    let cleanupWaitStarted = false;
    let cancelled = false;
    let cancelCalls = 0;
    let promptEligible = false;
    let handbackAfterCleanup = false;
    let settled = false;
    const d: Deps = {
      ...f.d,
      signal: controller.signal,
      trace: {
        ...diskTrace,
        started: async (...args) => {
          const accepted = await diskTrace.started(...args);
          traceCallbackEntered = true;
          await traceGate;
          return accepted;
        },
      },
      hosts: {
        ...f.d.hosts,
        codex: {
          start: async (input) => {
            const id = 'startup-abort-session';
            let accepted: boolean;
            try {
              accepted = await input.onStarted(id);
            } catch (error) {
              if (!cancelled) throw error;
              cleanupWaitStarted = true;
              await cleanupDone;
              handbackAfterCleanup = cleanupComplete;
              await input.onStartCancelled?.(id);
              throw error;
            }
            if (cancelled || !accepted) {
              cleanupWaitStarted = true;
              await cleanupDone;
              handbackAfterCleanup = cleanupComplete;
              await input.onStartCancelled?.(id);
              throw new Error(
                accepted
                  ? 'Codex startup was cancelled'
                  : 'session intent was already started',
              );
            }
            promptEligible = true;
            return {
              id,
              wait: async () => ({ reasonKind: 'exit', claimsDone: false }),
            };
          },
        },
        cancelTree: async (sessionId) => {
          assert.equal(sessionId, 'startup-abort-session');
          cancelCalls += 1;
          cancelled = true;
          await cleanupDone;
        },
      },
    };

    running = runJob(f.job, d);
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    assert.equal(
      await conditionWithin(() => traceCallbackEntered),
      true,
      'startup must reach the pending trace callback',
    );
    const bound = await relay.load(f.job, f.contract);
    assert.equal(
      bound.lease,
      'active',
      'binding must precede the pending trace callback',
    );
    assert.equal(bound.sessionId, 'startup-abort-session');
    controller.abort('test abort during startup callback');
    assert.equal(
      await conditionWithin(() => cancelCalls > 0),
      true,
      'foreman must cancel while the startup callback is pending',
    );
    assert.equal(
      promptEligible,
      false,
      'aborted startup must not make a prompt eligible',
    );
    releaseTrace();
    assert.equal(
      await conditionWithin(() => cleanupWaitStarted),
      true,
      'host must await physical cleanup before lease handback',
    );
    assert.equal(
      settled,
      false,
      'foreman must await physical cleanup before stopping',
    );
    assert.equal((await relay.load(f.job, f.contract)).lease, 'active');
    releaseCleanup();
    const outcome = await running;
    const handedBack = await relay.load(f.job, f.contract);
    assert.equal(outcome.kind, 'stop');
    assert.equal(promptEligible, false);
    assert.equal(cleanupComplete, true);
    assert.equal(handbackAfterCleanup, true);
    assert.equal(handedBack.lease, 'ended');
    assert.equal(handedBack.sessionId, undefined);
  } finally {
    releaseTrace?.();
    releaseCleanup?.();
    await running?.catch(() => undefined);
    await rm(f.worktree, { recursive: true, force: true });
  }
});
