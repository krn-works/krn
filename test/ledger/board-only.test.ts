import assert from 'node:assert/strict';
import test from 'node:test';
import type { Job } from '../../src/core/index.ts';
import {
  createLedger,
  parsePaperclipContract,
} from '../../src/ledger/index.ts';

const job: Job = { id: 'job-1', issue: 'issue-1', worktree: '/tmp/worktree' };
const sha = 'a'.repeat(40);
const resultHash = 'b'.repeat(64);
const description = [
  'Implement the requested change.',
  '```krn-contract',
  JSON.stringify({ version: 1, targetRepo: 'krn/krn', checks: ['gate'] }),
  '```',
].join('\n');

function issue(updatedAt = '2026-10-08T10:00:00.000Z', status = 'in_progress') {
  return {
    id: job.issue,
    title: 'Test issue',
    description,
    updatedAt,
    status,
    assigneeAgentId: 'agent-1',
  };
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function evidence(override: Record<string, unknown> = {}) {
  return {
    kind: 'verdict_pass' as const,
    sha,
    checks: [{ id: 'gate', exitCode: 0, durationMs: 20, sha256: resultHash }],
    ...override,
  };
}

test('invalid or missing krn-contract blocks are refused', () => {
  assert.equal(parsePaperclipContract('no contract').ok, false);
  assert.equal(parsePaperclipContract('```krn-contract\n{}\n```').ok, false);
});

test('blank Paperclip credentials are rejected before any request', () => {
  let requests = 0;
  assert.throws(
    () =>
      createLedger({
        apiUrl: 'http://paperclip.test',
        token: ' \t ',
        session: 'session-7',
        fetch: async () => {
          requests += 1;
          return response(issue());
        },
      }),
    /credential/i,
  );
  assert.equal(requests, 0);
});

test('readContract refuses a Paperclip issue without a valid contract block', async () => {
  const ledger = createLedger({
    apiUrl: 'http://paperclip.test',
    token: 'fixture-token',
    session: 'session-7',
    fetch: async () =>
      response({ ...issue(), description: 'No structured contract.' }),
  });
  await assert.rejects(
    ledger.readContract(job.issue),
    /missing or duplicate krn-contract block/,
  );
});

test('readBoard projects status, assignee, and update time without writing', async () => {
  let writes = 0;
  const ledger = createLedger({
    apiUrl: 'http://paperclip.test',
    token: 'fixture-token',
    session: 'session-7',
    fetch: async (_input, init) => {
      if (init?.method) writes += 1;
      return response(issue());
    },
  });
  assert.deepEqual(await ledger.readBoard(job), {
    status: 'in_progress',
    assignee: 'agent-1',
    updatedAt: '2026-10-08T10:00:00.000Z',
  });
  assert.equal(writes, 0);
});

test('revision changes between contract read and submit cause no write', async () => {
  const writes: Request[] = [];
  let reads = 0;
  const ledger = createLedger({
    apiUrl: 'http://paperclip.test',
    token: 'fixture-token',
    session: 'session-7',
    fetch: async (_input, init) => {
      if (init?.method === 'PATCH')
        writes.push(new Request('http://paperclip.test', init));
      reads += 1;
      return response(
        issue(
          reads === 1 ? '2026-10-08T10:00:00.000Z' : '2026-10-08T10:01:00.000Z',
        ),
      );
    },
  });
  const contract = await ledger.readContract(job.issue);
  assert.equal(
    await ledger.submitForReview(job, contract, evidence(), sha),
    'refused',
  );
  assert.equal(writes.length, 0);
});

test('intervening board update is corrected and returned as board_conflict', async () => {
  const activities: Array<Record<string, unknown>> = [];
  const patches: Array<{ status: string; comment: string }> = [];
  let status = 'in_progress';
  const ledger = createLedger({
    apiUrl: 'http://paperclip.test',
    token: 'fixture-token',
    session: 'session-7',
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/activity')) return response(activities);
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as {
          status: string;
          comment: string;
        };
        patches.push(body);
        if (body.status === 'in_review') {
          activities.push({
            id: 'concurrent-update',
            action: 'issue.updated',
            entityId: job.issue,
            createdAt: '2026-10-08T10:00:00.001Z',
            details: { priority: 'high' },
          });
          status = body.status;
          activities.push({
            id: 'ledger-update',
            action: 'issue.updated',
            entityId: job.issue,
            createdAt: '2026-10-08T10:00:00.002Z',
            details: { status: 'in_review', source: 'comment' },
          });
        } else {
          status = body.status;
        }
        return response(issue(undefined, status));
      }
      return response(issue(undefined, status));
    },
  });
  const contract = await ledger.readContract(job.issue);
  assert.equal(
    await ledger.submitForReview(job, contract, evidence(), sha),
    'board_conflict',
  );
  assert.deepEqual(
    patches.map((patch) => patch.status),
    ['in_review', 'in_progress'],
  );
  assert.match(patches[1]?.comment ?? '', /board conflict/i);
});

test('submission requires a verdict pass bound to the recorded SHA', async () => {
  const writes: Request[] = [];
  const ledger = createLedger({
    apiUrl: 'http://paperclip.test',
    token: 'fixture-token',
    session: 'session-7',
    fetch: async (_input, init) => {
      if (init?.method === 'PATCH')
        writes.push(new Request('http://paperclip.test', init));
      return response(
        issue(
          undefined,
          init?.method === 'PATCH' ? 'in_review' : 'in_progress',
        ),
      );
    },
  });
  const contract = await ledger.readContract(job.issue);
  assert.equal(
    await ledger.submitForReview(
      job,
      contract,
      evidence({ kind: 'fail' }),
      sha,
    ),
    'refused',
  );
  assert.equal(
    await ledger.submitForReview(job, contract, evidence(), 'c'.repeat(40)),
    'refused',
  );
  assert.equal(writes.length, 0);
});

test('review uses one in_review PATCH with SHA, check hashes, and session comment', async () => {
  const writes: Request[] = [];
  const activities: Array<Record<string, unknown>> = [];
  let status = 'in_progress';
  const ledger = createLedger({
    apiUrl: 'http://paperclip.test',
    token: 'fixture-token',
    session: 'session-7',
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/activity')) return response(activities);
      if (init?.method === 'PATCH') {
        writes.push(new Request('http://paperclip.test', init));
        status = 'in_review';
        activities.push({
          id: 'ledger-update',
          action: 'issue.updated',
          entityId: job.issue,
          createdAt: '2026-10-08T10:00:00.002Z',
          details: { status: 'in_review', source: 'comment' },
        });
      }
      return response(issue(undefined, status));
    },
  });
  const contract = await ledger.readContract(job.issue);
  assert.equal(
    await ledger.submitForReview(job, contract, evidence(), sha),
    'submitted',
  );
  assert.equal(writes.length, 1);
  const body = (await writes[0]?.json()) as { status: string; comment: string };
  assert.equal(body.status, 'in_review');
  assert.match(body.comment, /Krn-Session: session-7/);
  assert.match(body.comment, new RegExp(sha));
  assert.match(
    body.comment,
    new RegExp(`gate: pass; result sha256 ${resultHash}`),
  );
  assert.notEqual(body.status, 'done');
});

test('done issue is never moved by ledger', async () => {
  const writes: Request[] = [];
  const ledger = createLedger({
    apiUrl: 'http://paperclip.test',
    token: 'fixture-token',
    session: 'session-7',
    fetch: async (_input, init) => {
      if (init?.method === 'PATCH')
        writes.push(new Request('http://paperclip.test', init));
      return response(issue('2026-10-08T10:00:00.000Z', 'done'));
    },
  });
  const contract = await ledger.readContract(job.issue);
  assert.equal(
    await ledger.submitForReview(job, contract, evidence(), sha),
    'refused',
  );
  assert.equal(writes.length, 0);
});
