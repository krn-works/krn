import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Job } from '../../src/core/index.ts';
import { reportPassingVerdict } from '../../src/foreman/verdict.ts';
import {
  type BoardConflictRecord,
  type Contract,
  createLedger,
  type LedgerTransport,
  type SubmissionReceipt,
  type SubmitForReviewOptions,
  type VerdictEvidence,
} from '../../src/ledger/index.ts';
import * as trace from '../../src/trace/index.ts';

const issueId = 'issue-replay';
const sha = 'a'.repeat(40);
const resultHash = 'b'.repeat(64);
const description = [
  '```krn-contract',
  JSON.stringify({ version: 1, targetRepo: 'krn-works/krn', checks: ['gate'] }),
  '```',
].join('\n');

type ConflictRecord = {
  issueId: string;
  sha: string;
  comment: string;
  commentHash: string;
};

type ConflictState = {
  conflict: ConflictRecord;
  delivery: 'pending' | 'delivered';
};

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fixture(commentMode: 'fail' | 'lost') {
  const job: Job = {
    id: `submission-${commentMode}`,
    issue: issueId,
    worktree: process.cwd(),
  };
  const contract = {
    issueId,
    identifier: issueId,
    title: 'submission replay fixture',
    description,
    revision: '2026-10-12T18:00:00.000Z',
    targetRepo: 'krn-works/krn',
    checks: ['gate'],
  };
  let status = 'in_progress';
  let updatedAt = contract.revision;
  let patchCount = 0;
  let commentCount = 0;
  let foreignChangeApplied = false;
  const activities: Array<Record<string, unknown>> = [];
  const comments: Array<{ body: string; createdAt: string }> = [];
  let receipt: SubmissionReceipt | null = null;
  let conflict: ConflictRecord | null = null;
  let delivery: 'pending' | 'delivered' = 'pending';
  let failureReceipts = 0;
  const ledger = createLedger({
    apiUrl: 'http://paperclip.test',
    token: 'fixture-token',
    session: 'session-replay',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/activity')) return response(activities);
      if (url.pathname.endsWith('/comments') && init?.method === 'POST') {
        commentCount += 1;
        const body = JSON.parse(String(init.body)) as { body: string };
        if (commentMode === 'lost') {
          comments.push({
            body: body.body,
            createdAt: new Date().toISOString(),
          });
          throw new Error('simulated lost comment response');
        }
        if (commentCount === 1)
          return response({ message: 'temporary failure' }, 503);
        comments.push({
          body: body.body,
          createdAt: new Date().toISOString(),
        });
        return response({ id: 'conflict-comment' }, 201);
      }
      if (url.pathname.endsWith('/comments')) return response(comments);
      if (init?.method === 'PATCH') {
        patchCount += 1;
        const body = JSON.parse(String(init.body)) as {
          status: string;
          comment: string;
        };
        status = body.status;
        updatedAt = new Date().toISOString();
        activities.push(
          {
            id: 'ledger-status',
            action: 'issue.updated',
            entityId: issueId,
            createdAt: updatedAt,
            details: { status: 'in_review', source: 'comment' },
          },
          {
            id: 'ledger-review-comment',
            action: 'issue.commented',
            entityId: issueId,
            createdAt: updatedAt,
            details: { body: body.comment },
          },
        );
        return response({
          id: issueId,
          title: contract.title,
          description,
          updatedAt,
          status,
        });
      }
      if (patchCount > 0 && !foreignChangeApplied) {
        foreignChangeApplied = true;
        status = 'done';
        updatedAt = new Date(Date.now() + 2).toISOString();
        activities.push({
          id: 'human-status',
          action: 'issue.updated',
          entityId: issueId,
          createdAt: updatedAt,
          details: {
            status: 'done',
            changes: { status: { from: 'in_review', to: 'done' } },
          },
        });
      }
      return response({
        id: issueId,
        title: contract.title,
        description,
        updatedAt,
        status,
      });
    },
  });
  const trace = {
    readyForReview: async () => undefined,
    submittedFor: async () => receipt,
    submitted: (_job: Job, _sha: string, value: SubmissionReceipt) => {
      receipt = value;
    },
    submitIntent: async () => true,
    paperclipUpdateStarted: () => undefined,
    boardConflictFor: async (): Promise<ConflictState | null> =>
      conflict === null ? null : { conflict, delivery },
    boardConflict: (_job: Job, _sha: string, value: ConflictRecord) => {
      conflict = value;
      delivery = 'pending';
    },
    conflictCommentFailed: () => {
      failureReceipts += 1;
      delivery = 'pending';
    },
    conflictCommentDelivered: () => {
      delivery = 'delivered';
    },
  };
  const stop = (
    _job: Job,
    state: 'human_decision',
    reasons: readonly string[],
  ) => ({ kind: 'stop' as const, state, reasons });
  const report = () =>
    reportPassingVerdict(
      job,
      contract,
      sha,
      [{ id: 'gate', exitCode: 0, durationMs: 1, sha256: resultHash }],
      { submissionEnabled: false, submitForReview: ledger.submitForReview },
      trace,
      stop,
    );
  return {
    report,
    saturateComments: () => {
      while (comments.length < 500)
        comments.push({
          body: `older comment ${comments.length}`,
          createdAt: new Date().toISOString(),
        });
    },
    counts: () => ({
      patchCount,
      commentCount,
      status,
      conflict,
      delivery,
      failureReceipts,
    }),
  };
}

test('writable or unknown submissions fail closed without complete conflict persistence', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'krn-missing-conflict-persistence-'),
  );
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(['init', '-q', '--initial-branch=main']);
    await writeFile(join(root, 'README.md'), 'valid writable fixture\n');
    git(['add', 'README.md']);
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'test: valid writable fixture\n\nKrn-Session: session-write',
    ]);
    const validSha = git(['rev-parse', 'HEAD']);
    const job: Job = {
      id: 'missing-conflict-persistence',
      issue: issueId,
      worktree: root,
    };
    const contract: Contract = {
      issueId,
      identifier: issueId,
      title: 'valid writable fixture',
      description,
      revision: '2026-10-12T18:00:00.000Z',
      targetRepo: 'krn-works/krn',
      checks: ['gate'],
    };
    const evidence: VerdictEvidence = {
      kind: 'verdict_pass',
      sha: validSha,
      checks: [{ id: 'gate', exitCode: 0, durationMs: 1, sha256: resultHash }],
    };
    const observed: Array<Record<string, unknown>> = [];

    for (const submissionEnabled of [true, undefined]) {
      let boardWriteAttempts = 0;
      const ledger = {
        ...(submissionEnabled === undefined ? {} : { submissionEnabled }),
        submitForReview: async (
          _job: Job,
          _contract: Contract,
          receivedEvidence: VerdictEvidence,
          recordedSha: string,
          options?: SubmitForReviewOptions,
        ) => {
          assert.equal(receivedEvidence.sha, validSha);
          assert.equal(recordedSha, validSha);
          assert.equal(
            options?.session,
            submissionEnabled === true ? 'session-write' : undefined,
          );
          boardWriteAttempts += 1;
          return 'submitted' as const;
        },
      };
      const result = await reportPassingVerdict(
        job,
        contract,
        validSha,
        evidence.checks,
        ledger,
        {
          readyForReview: async () => undefined,
          paperclipUpdateStarted: () => undefined,
          submitIntent: async () => true,
          submittedFor: async () => null,
          submitted: () => undefined,
          boardConflictFor: async () => null,
          boardConflict: () => undefined,
          conflictCommentFailed: () => undefined,
        },
        (_job, state, reasons) => ({ kind: 'stop', state, reasons }),
      );
      observed.push({
        writeCapability:
          submissionEnabled === undefined ? 'unknown' : submissionEnabled,
        boardWriteAttempts,
        result,
      });
    }

    assert.deepEqual(observed, [
      {
        writeCapability: true,
        boardWriteAttempts: 0,
        result: {
          kind: 'stop',
          state: 'human_decision',
          reasons: ['conflict persistence unavailable'],
        },
      },
      {
        writeCapability: 'unknown',
        boardWriteAttempts: 0,
        result: {
          kind: 'stop',
          state: 'human_decision',
          reasons: ['conflict persistence unavailable'],
        },
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const partialCommentMetadataCases = [
  ['nextCursor', { nextCursor: 'page-2' }],
  ['unknown has_more metadata', { has_more: true }],
] as const;

async function replayWithPartialCommentMetadata(
  metadata: Readonly<Record<string, unknown>>,
) {
  const job: Job = {
    id: 'paginated-conflict-comment',
    issue: issueId,
    worktree: process.cwd(),
  };
  const contract: Contract = {
    issueId,
    identifier: issueId,
    title: 'paginated conflict fixture',
    description,
    revision: '2026-10-12T18:00:00.000Z',
    targetRepo: 'krn-works/krn',
    checks: ['gate'],
  };
  const evidence: VerdictEvidence = {
    kind: 'verdict_pass',
    sha,
    checks: [{ id: 'gate', exitCode: 0, durationMs: 1, sha256: resultHash }],
  };
  let status = 'in_progress';
  let updatedAt = contract.revision;
  let patchCount = 0;
  let commentReadCount = 0;
  let commentWriteCount = 0;
  const laterPage: Array<{ body: string }> = [];
  const activities: Array<Record<string, unknown>> = [];
  const transport: LedgerTransport = {
    readIssue: async () => ({
      id: issueId,
      title: contract.title,
      description,
      updatedAt,
      status,
    }),
    readActivity: async () => activities,
    readComments: async () => {
      commentReadCount += 1;
      if (commentReadCount === 1) return [];
      return {
        comments: [{ body: 'first page comment' }],
        ...metadata,
      };
    },
    postComment: async (_issue, body) => {
      commentWriteCount += 1;
      if (commentWriteCount === 1) {
        laterPage.push({ body });
        throw new Error('simulated accepted comment with lost response');
      }
      laterPage.push({ body });
      return { id: 'duplicate-conflict-comment' };
    },
    updateIssue: async (_issue, nextStatus) => {
      patchCount += 1;
      const receiptAt = '2026-10-12T18:01:00.000Z';
      updatedAt = '2026-10-12T18:01:00.002Z';
      status = 'done';
      activities.push({
        id: 'human-status',
        action: 'issue.updated',
        entityId: issueId,
        createdAt: updatedAt,
        details: {
          status: 'done',
          changes: { status: { from: nextStatus, to: 'done' } },
        },
      });
      return {
        id: issueId,
        title: contract.title,
        description,
        updatedAt: receiptAt,
        status: 'in_review',
      };
    },
  };
  const ledger = createLedger({ session: 'session-replay', transport });
  const conflicts: BoardConflictRecord[] = [];
  let delivery: 'pending' | 'delivered' = 'pending';
  let failures = 0;
  const callbacks = {
    onBoardConflict: (value: BoardConflictRecord) => {
      conflicts.push(value);
    },
    onConflictCommentFailed: () => {
      failures += 1;
      delivery = 'pending';
    },
    onConflictCommentDelivered: () => {
      delivery = 'delivered';
    },
  };

  const first = await ledger.submitForReview(
    job,
    contract,
    evidence,
    sha,
    callbacks,
  );
  assert.equal(first, 'board_conflict');
  assert.equal(conflicts.length, 1);
  const conflict = conflicts[0];
  assert.ok(conflict);
  assert.deepEqual(laterPage, [{ body: conflict.comment }]);
  assert.equal(commentWriteCount, 1);
  assert.equal(delivery, 'pending');

  const replay = await ledger.submitForReview(job, contract, evidence, sha, {
    ...callbacks,
    boardConflict: conflict,
  });
  assert.equal(replay, 'board_conflict');
  assert.equal(patchCount, 1);
  assert.deepEqual(laterPage, [{ body: conflict.comment }]);
  assert.equal(commentWriteCount, 1);
  assert.equal(delivery, 'pending');
  assert.equal(failures, 2);
}

for (const [metadataName, metadata] of partialCommentMetadataCases) {
  test(`a partial comments page with ${metadataName} cannot duplicate a lost-response conflict comment`, () =>
    replayWithPartialCommentMetadata(metadata));
}

test('same-SHA replay retries a failed conflict comment without another status PATCH', async () => {
  const run = fixture('fail');
  const expected = {
    kind: 'stop',
    state: 'human_decision',
    reasons: ['board_conflict'],
  };
  const first = await run.report().catch(() => null);
  assert.deepEqual(first, expected);
  const firstCounts = run.counts();
  assert.equal(firstCounts.patchCount, 1);
  assert.equal(firstCounts.commentCount, 1);
  assert.equal(firstCounts.status, 'done');
  assert.ok(firstCounts.conflict);
  assert.equal(firstCounts.delivery, 'pending');
  assert.equal(firstCounts.failureReceipts, 1);

  const replay = await run.report();
  assert.deepEqual(replay, expected);
  const counts = run.counts();
  assert.equal(counts.patchCount, 1);
  assert.equal(counts.commentCount, 2);
  assert.equal(counts.status, 'done');
  assert.ok(counts.conflict);
  assert.equal(counts.delivery, 'delivered');
});

test('same-SHA replay reconciles an accepted comment whose response was lost', async () => {
  const run = fixture('lost');
  const expected = {
    kind: 'stop',
    state: 'human_decision',
    reasons: ['board_conflict'],
  };
  const first = await run.report().catch(() => null);
  assert.deepEqual(first, expected);

  const replay = await run.report();
  assert.deepEqual(replay, expected);
  const counts = run.counts();
  assert.equal(counts.patchCount, 1);
  assert.equal(counts.commentCount, 1);
  assert.equal(counts.status, 'done');
  assert.ok(counts.conflict);
  assert.equal(counts.delivery, 'delivered');
});

test('a full comment read stays pending instead of risking a duplicate', async () => {
  const run = fixture('fail');
  const expected = {
    kind: 'stop',
    state: 'human_decision',
    reasons: ['board_conflict'],
  };
  assert.deepEqual(await run.report(), expected);
  run.saturateComments();

  assert.deepEqual(await run.report(), expected);
  const counts = run.counts();
  assert.equal(counts.patchCount, 1);
  assert.equal(counts.commentCount, 1);
  assert.equal(counts.status, 'done');
  assert.equal(counts.delivery, 'pending');
  assert.equal(counts.failureReceipts, 2);
});

test('board conflict and comment delivery remain separate durable trace facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'krn-conflict-trace-'));
  try {
    const initialized = spawnSync('git', ['-C', root, 'init', '-q'], {
      encoding: 'utf8',
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    const job: Job = { id: 'conflict-trace', issue: issueId, worktree: root };
    const comment = 'Krn-Session: session-replay\nBoard conflict.';
    const conflict = {
      issueId,
      sha,
      comment,
      commentHash: createHash('sha256').update(comment).digest('hex'),
    };

    trace.boardConflict(job, sha, conflict);
    trace.conflictCommentFailed(job, sha);
    assert.deepEqual(await trace.boardConflictFor(job, sha), {
      conflict,
      delivery: 'pending',
    });

    trace.conflictCommentDelivered(job, sha);
    assert.deepEqual(await trace.boardConflictFor(job, sha), {
      conflict,
      delivery: 'delivered',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
