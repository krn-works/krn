import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { recordRepo } from '../../src/foreman/state.ts';
import { reportPassingVerdict } from '../../src/foreman/verdict.ts';
import type {
  SubmissionReceipt,
  SubmissionReconciliation,
} from '../../src/ledger/index.ts';
import { createLedger } from '../../src/ledger/index.ts';
import * as trace from '../../src/trace/index.ts';

const sha = 'a'.repeat(40);
const jobBase = {
  id: 'ledger-replay-falsifier',
  issue: 'LON-249',
};
const contract = {
  issueId: 'LON-249',
  identifier: 'LON-249',
  title: 'Ledger replay falsifier',
  description: '',
  revision: '2016-10-11T13:00:00.000Z',
  targetRepo: 'krn-works/krn',
  checks: ['gate'],
};
const checks = [
  {
    id: 'gate',
    exitCode: 0,
    durationMs: 1,
    sha256: 'b'.repeat(64),
  },
];
const serverBeforeAt = '2016-10-11T13:00:00.000Z';
const serverReceiptAt = '2016-10-11T13:00:01.000Z';

async function makeRepo(): Promise<string> {
  const scratch = join(process.cwd(), '.krn', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'krn-ledger-replay-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q', '--initial-branch=main']);
  git(['config', 'user.name', 'KRN Test Fixture']);
  git(['config', 'user.email', 'krn-test@example.invalid']);
  await writeFile(join(root, 'README.md'), 'ledger replay falsifier\n');
  git(['add', 'README.md']);
  git(['commit', '-qm', 'test: initialize ledger replay fixture']);
  return root;
}

test('same-SHA replay preserves a board conflict separately from its PATCH receipt', async () => {
  const root = await makeRepo();
  const job = { ...jobBase, worktree: root };
  recordRepo(job, root);
  const receipt = {
    issueId: job.issue,
    status: 'in_review',
    updatedAt: '2036-10-11T13:00:01.000Z',
  };
  let submissions = 0;
  const ledger = {
    submitForReview: async (
      _job: typeof job,
      _contract: typeof contract,
      _evidence: { kind: 'verdict_pass'; sha: string; checks: typeof checks },
      _recordedSha: string,
      options?: {
        onSubmitted?: (value: SubmissionReceipt) => void;
        onReconciled?: (value: SubmissionReconciliation) => void;
      },
    ) => {
      submissions += 1;
      options?.onSubmitted?.(receipt);
      options?.onReconciled?.('board_conflict');
      return 'board_conflict' as const;
    },
  };
  const stop = (
    _job: typeof job,
    state: 'human_decision',
    reasons: readonly string[],
  ) => ({ kind: 'stop', state, reasons }) as const;

  try {
    const first = await reportPassingVerdict(
      job,
      contract,
      sha,
      checks,
      ledger,
      trace,
      stop,
    );
    assert.deepEqual(first, {
      kind: 'stop',
      state: 'human_decision',
      reasons: ['board_conflict'],
    });

    const replay = await reportPassingVerdict(
      job,
      contract,
      sha,
      checks,
      ledger,
      trace,
      stop,
    );
    assert.deepEqual(replay, {
      kind: 'stop',
      state: 'human_decision',
      reasons: ['board_conflict'],
    });
    assert.equal(submissions, 1, 'a recorded reconciliation must be terminal');
    const traceEvents = (
      await readFile(
        join(root, '.krn', 'runs', 'foreman', job.id, 'trace.jsonl'),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string });
    const receiptIndex = traceEvents.findIndex(
      (event) => event.kind === 'submitted',
    );
    const reconciliationIndex = traceEvents.findIndex(
      (event) => event.kind === 'submission_reconciled',
    );
    assert.notEqual(receiptIndex, -1, 'PATCH receipt must be traced');
    assert.notEqual(
      reconciliationIndex,
      -1,
      'reconciliation result must be traced separately',
    );
    assert.ok(receiptIndex < reconciliationIndex);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function boardIssue(status: string, updatedAt: string) {
  return {
    id: 'LON-249',
    title: 'Ledger replay falsifier',
    description: '',
    updatedAt,
    status,
  };
}

function event(
  id: string,
  action: string,
  createdAt: string,
  details: Record<string, unknown>,
) {
  return { id, action, entityId: 'LON-249', createdAt, details };
}

function serverClockLedger(includeForeignEvent: boolean) {
  let status = 'in_progress';
  let updatedAt = serverBeforeAt;
  const activities: Array<Record<string, unknown>> = [];
  const conflictComments: string[] = [];
  const conflictStatusWrites: string[] = [];
  const transport = {
    readIssue: async () => boardIssue(status, updatedAt),
    readActivity: async () => [...activities],
    readComments: async () => [],
    updateIssue: async (
      _issueId: string,
      nextStatus: string,
      comment: string,
    ) => {
      if (comment.includes('Board conflict after')) {
        conflictStatusWrites.push(nextStatus);
        status = nextStatus;
        return boardIssue(status, updatedAt);
      }
      status = nextStatus;
      updatedAt = serverReceiptAt;
      activities.push(
        event('own-update', 'issue.updated', serverReceiptAt, {
          changes: { status: { from: 'in_progress', to: 'in_review' } },
        }),
        event('own-comment', 'issue.commented', serverReceiptAt, {
          body: comment,
        }),
      );
      if (includeForeignEvent)
        activities.push(
          event(
            'foreign-assignment',
            'issue.assigned',
            '2016-10-11T13:00:01.200Z',
            { assigneeId: 'human-agent' },
          ),
        );
      return boardIssue(status, updatedAt);
    },
    commentIssue: async (_issueId: string, comment: string) => {
      conflictComments.push(comment);
      return { id: 'conflict-comment' };
    },
  };
  const ledger = createLedger({ session: 'session-7', transport });
  return {
    ledger,
    conflictComments,
    conflictStatusWrites,
    setHumanStatus: () => {
      status = 'done';
    },
    status: () => status,
  };
}

test('server timestamps recognize the paired own events despite host clock skew', async () => {
  const board = serverClockLedger(false);
  const result = await board.ledger.submitForReview(
    { ...jobBase, worktree: process.cwd() },
    contract,
    { kind: 'verdict_pass', sha, checks },
    sha,
  );
  assert.equal(result, 'submitted');
  assert.equal(board.conflictComments.length, 0);
});

test('paired own events plus one foreign event alone cause conflict without status overwrite', async () => {
  const board = serverClockLedger(true);
  const result = await board.ledger.submitForReview(
    { ...jobBase, worktree: process.cwd() },
    contract,
    { kind: 'verdict_pass', sha, checks },
    sha,
    {
      onWriteStarted: (kind) => {
        if (kind === 'conflict_comment') board.setHumanStatus();
      },
    },
  );
  assert.equal(result, 'board_conflict');
  assert.equal(board.conflictStatusWrites.length, 0);
  assert.equal(board.status(), 'done');
  assert.match(board.conflictComments[0] ?? '', /issue\.assigned/);
  assert.doesNotMatch(board.conflictComments[0] ?? '', /issue\.updated/);
  assert.doesNotMatch(board.conflictComments[0] ?? '', /issue\.commented/);
});
