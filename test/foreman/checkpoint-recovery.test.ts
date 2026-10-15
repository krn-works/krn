import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  finishCheckpoint,
  isCheckpointRefusal,
} from '../../src/foreman/checkpoint.ts';
import { writeCheckpointRequest } from '../../src/foreman/checkpoint-request.ts';
import { runJob } from '../../src/foreman/run.ts';
import { recordRepo, stateDirectory } from '../../src/foreman/state.ts';
import type { Capsule, Deps, Outcome } from '../../src/foreman/types.ts';
import type { Contract } from '../../src/ledger/index.ts';
import * as relay from '../../src/relay/index.ts';
import * as trace from '../../src/trace/index.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

const message = 'feat: recover the interrupted step';
const sessionId = 'session-recovery-1';

type Decision = Capsule['decisions'][number];

async function fixture(jobId: string, options: { readonly checks: string[] }) {
  const root = realpathSync(
    await mkdtemp(join(tmpdir(), 'krn-checkpoint-recovery-')),
  );
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q', '--initial-branch=main']);
  git(['config', 'user.name', 'Foreman']);
  git(['config', 'user.email', 'foreman@example.invalid']);
  await writeFile(join(root, '.gitignore'), '.krn/\n');
  await writeFile(join(root, 'README.md'), 'fixture\n');
  await writeFile(
    join(root, 'krn.checks.json'),
    JSON.stringify({
      version: 1,
      checks: [{ id: 'always', argv: ['/usr/bin/true'], timeoutMs: 3000 }],
    }),
  );
  git(['add', '.gitignore', 'README.md', 'krn.checks.json']);
  git(['commit', '-qm', 'fixture']);
  const base = git(['rev-parse', 'HEAD']);
  const job = { id: jobId, issue: jobId, worktree: root, repoRoot: root };
  recordRepo(job, root, undefined, base);
  const contract: Contract = {
    issueId: job.issue,
    identifier: job.issue,
    title: 'checkpoint recovery fixture',
    description: 'checkpoint recovery fixture',
    revision: 'r1',
    targetRepo: 'fixture/repo',
    checks: options.checks,
  };
  const sessions: string[] = [];
  const deps: Deps = {
    budget: { maxResets: 1, maxRepairs: 0, session: { timeoutMs: 1000 } },
    ledger: {
      readContract: async () => contract,
      submitForReview: async () => 'ready_for_review',
    },
    relay,
    trace,
    hosts: {
      codex: {
        // Fake backend: a fresh session binds and ends without new work.
        start: async (input) => {
          const id = `session-fresh-${sessions.length + 1}`;
          assert.equal(await input.onStarted(id), true);
          sessions.push(id);
          return {
            id,
            wait: async () => ({ reasonKind: 'exit', claimsDone: false }),
          };
        },
      },
      cancelTree: async () => undefined,
    },
    stop: (_job, state, reasons): Outcome => ({ kind: 'stop', state, reasons }),
  };
  return {
    root,
    base,
    job,
    contract,
    deps,
    sessions,
    git,
    commitsSinceBase: () =>
      Number(git(['rev-list', '--count', `${base}..HEAD`])),
    traceEvents: () =>
      readFileSync(join(stateDirectory(job), 'trace.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              kind: string;
              data: Record<string, unknown>;
            },
        ),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

// Real relay, trace and git state up to the worker's checkpoint request.
async function requestCheckpoint(
  f: Fixture,
  next: string,
  decisions: readonly Decision[] = [],
) {
  let capsule = await relay.load(f.job, f.contract);
  if (decisions.length) {
    const seeded = await relay.writeCapsule(
      f.job,
      { ...capsule, epoch: capsule.epoch + 1, decisions },
      capsule.epoch,
    );
    assert.equal(seeded.applied, true, 'seeded capsule must be admissible');
    if (seeded.applied) capsule = seeded.value;
  }
  const intent = await trace.intent(f.job, capsule.epoch);
  const bound = await relay.bindSession(f.job, capsule, sessionId);
  assert.equal(bound.applied, true);
  assert.equal(await trace.started(f.job, intent, sessionId), true);
  await writeFile(join(f.root, 'step.txt'), 'worker step\n');
  writeCheckpointRequest(f.job, { intent, sessionId, message, next });
  return { intent, capsule: (bound as { value: Capsule }).value };
}

function crashAt(
  f: Fixture,
  point: 'trace.commit' | 'relay.recordCommit',
): Deps {
  const crash = async () => {
    throw new Error(`injected crash at ${point}`);
  };
  return point === 'trace.commit'
    ? { ...f.deps, trace: { ...f.deps.trace, commit: crash } }
    : { ...f.deps, relay: { ...f.deps.relay, recordCommit: crash } };
}

async function interruptAfterCommit(
  f: Fixture,
  point: 'trace.commit' | 'relay.recordCommit',
  next: string,
) {
  const { intent, capsule } = await requestCheckpoint(f, next);
  await assert.rejects(
    finishCheckpoint(f.job, capsule, intent, crashAt(f, point)),
    new RegExp(`injected crash at ${point.replace('.', '\\.')}`),
  );
  // The interrupted foreman left exactly one commit that the capsule never recorded.
  assert.equal(f.commitsSinceBase(), 1);
  assert.equal((await relay.load(f.job, f.contract)).head, f.base);
  return f.git(['rev-parse', 'HEAD']);
}

for (const point of ['trace.commit', 'relay.recordCommit'] as const) {
  test(`a commit interrupted before ${point} is adopted and verified on resume`, async () => {
    const f = await fixture('recover-done', { checks: [] });
    try {
      const head = await interruptAfterCommit(f, point, 'done');
      const outcome = await runJob(f.job, f.deps);
      // The verdict ran on the adopted commit: an empty contract is refused by judge().
      assert.deepEqual(outcome, {
        kind: 'stop',
        state: 'human_decision',
        reasons: ['zero declared checks'],
      });
      assert.equal(f.sessions.length, 0);
      assert.equal(f.git(['rev-parse', 'HEAD']), head);
      assert.equal(f.commitsSinceBase(), 1);
      const capsule = await relay.load(f.job, f.contract);
      assert.equal(capsule.head, head);
      assert.equal(
        capsule.decisions.at(-1)?.text,
        `foreman commit ${head}: ${message}`,
      );
      const commits = f.traceEvents().filter((e) => e.kind === 'commit');
      assert.deepEqual(
        commits.map((e) => e.data.sha),
        [head],
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test('an adopted unfinished checkpoint continues in one fresh session', async () => {
  const f = await fixture('recover-next', { checks: [] });
  try {
    const head = await interruptAfterCommit(f, 'trace.commit', 'step B');
    const outcome = await runJob(f.job, f.deps);
    assert.deepEqual(outcome, {
      kind: 'stop',
      state: 'human_decision',
      reasons: ['no_progress'],
    });
    assert.equal(f.sessions.length, 1);
    assert.equal(f.git(['rev-parse', 'HEAD']), head);
    assert.equal(f.commitsSinceBase(), 1);
    assert.equal((await relay.load(f.job, f.contract)).head, head);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('an adopted checkpoint passes the real verdict on resume', async (t) => {
  if (
    !requiresIsolation(
      t,
      'an adopted checkpoint passes the real verdict on resume',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
  const f = await fixture('recover-pass', { checks: ['always'] });
  try {
    const head = await interruptAfterCommit(f, 'trace.commit', 'done');
    const outcome = await runJob(f.job, f.deps);
    assert.deepEqual(outcome, {
      kind: 'verdict_pass',
      state: 'ready_for_review',
      sha: head,
    });
    assert.equal(f.sessions.length, 0);
    assert.equal(f.commitsSinceBase(), 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

async function assertForeignHeadRefused(
  f: Fixture,
  foreign: string,
  reason: string,
) {
  const before = await relay.load(f.job, f.contract);
  const outcome = await runJob(f.job, f.deps);
  assert.deepEqual(outcome, {
    kind: 'stop',
    state: 'human_decision',
    reasons: ['HEAD changed', `checkpoint commit not adopted: ${reason}`],
  });
  assert.equal(f.sessions.length, 0);
  assert.equal(f.git(['rev-parse', 'HEAD']), foreign);
  const after = await relay.load(f.job, f.contract);
  assert.equal(after.head, before.head);
  assert.equal(after.epoch, before.epoch);
  assert.equal(
    f.traceEvents().some((e) => e.kind === 'commit' && e.data.sha === foreign),
    false,
  );
}

test('a same-message commit with a different tree is not adopted', async () => {
  const f = await fixture('foreign-tree', { checks: [] });
  try {
    await interruptAfterCommit(f, 'trace.commit', 'done');
    f.git(['reset', '-q', '--hard', f.base]);
    await writeFile(join(f.root, 'other.txt'), 'foreign change\n');
    f.git(['add', 'other.txt']);
    f.git(['commit', '-qm', `${message}\n\nKrn-Session: ${sessionId}`]);
    await assertForeignHeadRefused(
      f,
      f.git(['rev-parse', 'HEAD']),
      'HEAD tree differs from the recorded checkpoint tree',
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a commit stacked on the interrupted checkpoint is not adopted', async () => {
  const f = await fixture('foreign-stack', { checks: [] });
  try {
    await interruptAfterCommit(f, 'trace.commit', 'done');
    await writeFile(join(f.root, 'later.txt'), 'later change\n');
    f.git(['add', 'later.txt']);
    f.git(['commit', '-qm', 'chore: unrelated later commit']);
    await assertForeignHeadRefused(
      f,
      f.git(['rev-parse', 'HEAD']),
      'HEAD is not a single commit on the recorded parent',
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a moved HEAD without a recorded commit intent is not adopted', async () => {
  const f = await fixture('foreign-nointent', { checks: [] });
  try {
    // Interrupted after the checkpoint request was recorded, then HEAD moved
    // without any foreman commit intent.
    const { intent } = await requestCheckpoint(f, 'done');
    await relay.checkpoint(f.job, sessionId, message, 'done');
    await trace.checkpoint(f.job, intent, sessionId, message, 'done');
    f.git(['add', 'step.txt']);
    f.git(['commit', '-qm', `${message}\n\nKrn-Session: ${sessionId}`]);
    await assertForeignHeadRefused(
      f,
      f.git(['rev-parse', 'HEAD']),
      'no recorded commit intent for the checkpoint session',
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

async function assertRefusedBeforeHeadChanges(
  f: Fixture,
  next: string,
  decisions: readonly Decision[],
  refusal: RegExp,
) {
  const { intent, capsule } = await requestCheckpoint(f, next, decisions);
  const failure = await finishCheckpoint(f.job, capsule, intent, f.deps).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.equal(f.git(['rev-parse', 'HEAD']), f.base);
  assert.equal(isCheckpointRefusal(failure), true, String(failure));
  assert.match(String(failure), refusal);
  assert.equal(f.commitsSinceBase(), 0);
  assert.equal(f.git(['diff', '--cached', '--name-only']), '');
  assert.equal(
    f.traceEvents().some((e) => e.kind === 'commit'),
    false,
  );
}

function decision(text: string): Decision {
  return { date: new Date().toISOString(), source: 'fixture', text };
}

test('a full capsule history refuses the checkpoint before HEAD changes', async () => {
  const f = await fixture('history-full', { checks: [] });
  try {
    // 63 + the commit request = 64 admitted; the commit record would be the 65th.
    const decisions = Array.from({ length: 63 }, (_, index) =>
      decision(`fixture decision ${index}`),
    );
    await assertRefusedBeforeHeadChanges(
      f,
      'done',
      decisions,
      /capsule history exceeds 64 decisions/u,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('an exhausted projection budget refuses the checkpoint before HEAD changes', async () => {
  const f = await fixture('budget-full', { checks: [] });
  try {
    const template = await relay.load(f.job, f.contract);
    const date = new Date().toISOString();
    const request = {
      date,
      source: sessionId,
      text: `commit request: ${message}`,
    };
    const record = {
      date,
      source: sessionId,
      text: `foreman commit ${'f'.repeat(f.base.length)}: ${message}`,
    };
    let probes = 0;
    // Probe the real store with same-length job IDs; no budget value is copied here.
    const fits = async (decisions: readonly Decision[]) => {
      const id = `bp${String(probes++).padStart(9, '0')}`;
      assert.equal(id.length, f.job.id.length);
      const probe = { ...f.job, id, issue: f.job.issue };
      const result = await relay.writeCapsule(
        probe,
        {
          ...template,
          jobId: id,
          epoch: 0,
          lease: 'checkpointed',
          nextAction: 'done',
          sessionId,
          decisions,
        },
        null,
      );
      return result.applied;
    };
    const filler = (length: number) => decision('x'.repeat(length));
    let low = 1;
    let high = 16_000;
    assert.equal(await fits([filler(low), request]), true);
    assert.equal(await fits([filler(high), request]), false);
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (await fits([filler(middle), request])) low = middle;
      else high = middle;
    }
    assert.equal(await fits([filler(low), request, record]), false);
    await assertRefusedBeforeHeadChanges(
      f,
      'done',
      [filler(low)],
      /capsule exceeds the 2k-token projection budget/u,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
