import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { runJob } from '../../src/foreman/run.ts';
import { recordRepo } from '../../src/foreman/state.ts';
import type { Deps } from '../../src/foreman/types.ts';
import { createLedger } from '../../src/ledger/index.ts';
import * as trace from '../../src/trace/index.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

const revision = '2026-10-08T10:00:00.000Z';
const issueId = 'I-SUBMIT-REPLAY';

async function fixture(failFirstUpdate = false) {
  const scratch = join(process.cwd(), '.krn', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'krn-submit-replay-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q', '--initial-branch=main']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(root, '.gitignore'), '.krn/\n');
  await writeFile(join(root, 'README.md'), 'submit replay fixture\n');
  await writeFile(
    join(root, 'krn.checks.json'),
    JSON.stringify({
      version: 1,
      checks: [{ id: 'gate', argv: ['/usr/bin/true'], timeoutMs: 3000 }],
    }),
  );
  git(['add', '.gitignore', 'README.md', 'krn.checks.json']);
  git(['commit', '-qm', 'test: initialize submit replay fixture']);
  const sha = git(['rev-parse', 'HEAD']);
  const job = {
    id: 'submit-replay',
    issue: issueId,
    worktree: root,
    repoRoot: root,
  };
  const capsule = {
    jobId: job.id,
    issue: issueId,
    contractRevision: revision,
    epoch: 0,
    base: sha,
    head: sha,
    branch: 'main',
    worktree: root,
    nextAction: 'done',
    lease: 'checkpointed' as const,
    blockers: [],
    decisions: [],
    rejectedApproaches: [],
    references: [],
  };
  recordRepo(job, root);

  const description = [
    '```krn-contract',
    JSON.stringify({
      version: 1,
      targetRepo: 'fixture/repo',
      checks: ['gate'],
    }),
    '```',
  ].join('\n');
  let status = 'in_progress';
  let updatedAt = revision;
  let updates = 0;
  const activities: Array<Record<string, unknown>> = [];
  const comments: Array<{ body: string; createdAt: string }> = [];
  const issue = () => ({
    id: issueId,
    identifier: issueId,
    title: 'Submit replay fixture',
    description,
    updatedAt,
    status,
    assigneeAgentId: 'fixture-agent',
  });
  const transport = {
    readIssue: async () => issue(),
    readActivity: async () => [...activities],
    readComments: async () => [...comments],
    updateIssue: async (_id: string, newStatus: string, comment: string) => {
      updates += 1;
      status = newStatus;
      updatedAt = new Date().toISOString();
      comments.push({
        body: comment,
        createdAt: updatedAt,
      });
      activities.push(
        {
          id: `update-${updates}`,
          action: 'issue.updated',
          entityId: issueId,
          createdAt: updatedAt,
          details: {
            changes: { status: { from: 'in_progress', to: newStatus } },
          },
        },
        {
          id: `comment-${updates}`,
          action: 'issue.commented',
          entityId: issueId,
          createdAt: updatedAt,
          details: { body: comment },
        },
      );
      if (failFirstUpdate && updates === 1)
        throw new Error('simulated process crash after Paperclip PATCH');
      return issue();
    },
  };
  const ledger = createLedger({ session: 'fixture-session', transport });
  const deps: Deps = {
    budget: { maxResets: 0, maxRepairs: 0, session: { timeoutMs: 1000 } },
    ledger,
    relay: {
      load: async () => capsule,
      repoFacts: async () => ({
        base: sha,
        head: sha,
        branch: 'main',
        worktree: root,
      }),
      validate: () => ({ ok: true }),
      project: () => 'unused; terminal replay must not start a worker',
    } as unknown as Deps['relay'],
    trace,
    hosts: {
      codex: {
        start: async () => {
          throw new Error('terminal replay must not start a session');
        },
      },
      cancelTree: async () => undefined,
    },
    stop: (_job, state, reasons) => ({ kind: 'stop', state, reasons }),
  };
  await trace.verdict(job, {
    sha,
    checks: [
      { id: 'gate', exitCode: 0, durationMs: 1, sha256: 'b'.repeat(64) },
    ],
  });
  const events = async () =>
    (
      await readFile(
        join(root, '.krn', 'runs', 'foreman', job.id, 'trace.jsonl'),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as { kind: string; data: Record<string, unknown> },
      );
  return { root, job, deps, events, updateCount: () => updates };
}

test('two terminal replays submit one Paperclip update', async (t) => {
  if (
    !requiresIsolation(t, 'two terminal replays submit one Paperclip update', [
      'bwrap',
      'systemdUserScope',
    ])
  )
    return;
  const f = await fixture();
  try {
    const first = await runJob(f.job, f.deps);
    const second = await runJob(f.job, f.deps);
    assert.deepEqual(first, {
      kind: 'verdict_pass',
      state: 'in_review',
      sha: (await f.deps.relay.repoFacts(f.job)).head,
    });
    assert.deepEqual(second, first);
    assert.equal(f.updateCount(), 1);
    const events = await f.events();
    assert.equal(
      events.filter((event) => event.kind === 'submit_intent').length,
      1,
    );
    assert.equal(
      events.filter((event) => event.kind === 'submitted').length,
      1,
    );
    const kinds = events.map((event) => event.kind);
    assert.ok(
      kinds.indexOf('submit_intent') <
        kinds.indexOf('paperclip_update_started'),
    );
    assert.ok(
      kinds.indexOf('paperclip_update_started') < kinds.indexOf('submitted'),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('replay reconciles a PATCH whose submitted trace event was lost', async (t) => {
  if (
    !requiresIsolation(
      t,
      'replay reconciles a PATCH whose submitted trace event was lost',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
  const f = await fixture(true);
  try {
    await assert.rejects(
      runJob(f.job, f.deps),
      /simulated process crash after Paperclip PATCH/u,
    );
    assert.equal(f.updateCount(), 1);
    let events = await f.events();
    assert.equal(
      events.filter((event) => event.kind === 'submit_intent').length,
      1,
    );
    assert.equal(
      events.filter((event) => event.kind === 'paperclip_update_started')
        .length,
      1,
    );
    assert.equal(
      events.filter((event) => event.kind === 'submitted').length,
      0,
    );

    const replay = await runJob(f.job, f.deps);
    assert.deepEqual(replay, {
      kind: 'verdict_pass',
      state: 'in_review',
      sha: (await f.deps.relay.repoFacts(f.job)).head,
    });
    assert.equal(
      f.updateCount(),
      1,
      'matching latest KRN comment must reconcile without another update',
    );
    events = await f.events();
    assert.equal(
      events.filter((event) => event.kind === 'submitted').length,
      1,
    );
    assert.equal(
      events.filter((event) => event.kind === 'paperclip_update_started')
        .length,
      1,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
