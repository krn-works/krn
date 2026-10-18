import assert from 'node:assert/strict';
import test from 'node:test';
import { reportPassingVerdict } from '../../src/foreman/verdict.ts';
import { createLedger } from '../../src/ledger/index.ts';
import {
  loadLiveContract,
  withLiveSubmissionGate,
} from '../../src/ledger/live.ts';

const issueId = 'issue-7';
const description = [
  '```krn-contract',
  JSON.stringify({ version: 1, targetRepo: 'krn-works/krn', checks: ['gate'] }),
  '```',
].join('\n');

function issue(
  updatedAt = '2026-10-08T10:00:00.000Z',
  issueDescription = description,
) {
  return {
    id: issueId,
    title: 'Live contract fixture',
    description: issueDescription,
    updatedAt,
    status: 'in_progress',
    assigneeAgentId: 'agent-7',
  };
}

function paperclip(fetch: typeof globalThis.fetch) {
  return createLedger({
    apiUrl: 'http://paperclip.test',
    token: 'fixture-token',
    session: 'fixture-session',
    fetch,
  });
}

function response(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
}

test('live contract loads real checks and board view with no writes by default', async () => {
  const requests: string[] = [];
  const methods: string[] = [];
  const ledger = paperclip(async (input, init) => {
    requests.push(String(input));
    methods.push(init?.method ?? 'GET');
    return response(issue());
  });

  const live = await loadLiveContract(ledger, issueId, {
    origin: 'git@github.com:krn-works/krn.git',
  });

  assert.deepEqual(live.contract, {
    issueId,
    identifier: issueId,
    title: 'Live contract fixture',
    description,
    revision: '2026-10-08T10:00:00.000Z',
    targetRepo: 'krn-works/krn',
    checks: ['gate'],
  });
  assert.deepEqual(live.board, {
    status: 'in_progress',
    assignee: 'agent-7',
    updatedAt: '2026-10-08T10:00:00.000Z',
  });
  assert.equal(requests.length, 2);
  assert.ok(
    requests.every((request) => request.endsWith(`/api/issues/${issueId}`)),
  );
  const gated = withLiveSubmissionGate(ledger, false);
  const trace: string[] = [];
  const outcome = await reportPassingVerdict(
    { id: 'job-7', issue: issueId, worktree: '/tmp/live' },
    live.contract,
    'a'.repeat(40),
    [{ id: 'gate', exitCode: 0, durationMs: 1, sha256: 'b'.repeat(64) }],
    gated,
    {
      readyForReview: async (_job, sha) => {
        trace.push(sha);
      },
    },
    (_job, state, reasons) => ({ kind: 'stop', state, reasons }),
  );
  assert.deepEqual(outcome, {
    kind: 'verdict_pass',
    state: 'ready_for_review',
    sha: 'a'.repeat(40),
  });
  assert.deepEqual(trace, ['a'.repeat(40)]);
  assert.deepEqual(methods, ['GET', 'GET']);
});

test('requested revision must match the live Paperclip board revision', async () => {
  const ledger = paperclip(async () => response(issue()));
  await assert.rejects(
    loadLiveContract(ledger, issueId, {
      origin: 'https://github.com/krn-works/krn.git',
      revision: 'old-revision',
    }),
    /revision mismatch/u,
  );
});

test('contract targetRepo must match the origin remote', async () => {
  const ledger = paperclip(async () => response(issue()));
  await assert.rejects(
    loadLiveContract(ledger, issueId, {
      origin: 'https://github.com/other/project.git',
    }),
    /targetRepo mismatch/u,
  );
});

test('loadLiveContract refuses duplicate R1-task declarations', async () => {
  const duplicateDescription = [
    'R1-task: none',
    'R1-task: R1-23',
    '',
    '```krn-contract',
    JSON.stringify({
      version: 1,
      targetRepo: 'krn-works/krn',
      checks: ['gate'],
    }),
    '```',
  ].join('\n');
  const methods: string[] = [];
  const ledger = paperclip(async (_input, init) => {
    methods.push(init?.method ?? 'GET');
    return response(issue('2026-10-08T10:00:00.000Z', duplicateDescription));
  });

  await assert.rejects(
    loadLiveContract(ledger, issueId, {
      origin: 'https://github.com/krn-works/krn.git',
    }),
    /R1-task/u,
  );
  assert.deepEqual(methods, ['GET', 'GET']);
});

test('a board change between contract and board reads refuses the run', async () => {
  let reads = 0;
  const ledger = paperclip(async () =>
    response(
      issue(
        ++reads === 1 ? '2026-10-08T10:00:00.000Z' : '2026-10-08T10:01:00.000Z',
      ),
    ),
  );
  await assert.rejects(
    loadLiveContract(ledger, issueId, {
      origin: 'https://github.com/krn-works/krn.git',
    }),
    /board changed while loading contract/u,
  );
});
