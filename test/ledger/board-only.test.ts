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

test('readContract returns the task contract from its single issue read', async () => {
  let reads = 0;
  const ledger = createLedger({
    apiUrl: 'http://paperclip.test',
    token: 'fixture-token',
    session: 'session-7',
    fetch: async () => {
      reads += 1;
      return response(issue());
    },
  });

  assert.deepEqual(await ledger.readContract(job.issue), {
    issueId: job.issue,
    identifier: job.issue,
    title: 'Test issue',
    description,
    revision: '2026-10-08T10:00:00.000Z',
    targetRepo: 'krn/krn',
    checks: ['gate'],
  });
  assert.equal(reads, 1);
});

test('readContract refuses descriptions larger than 8 KB', async () => {
  const ledger = createLedger({
    apiUrl: 'http://paperclip.test',
    token: 'fixture-token',
    session: 'session-7',
    fetch: async () =>
      response({
        ...issue(),
        description: `${description}${'x'.repeat(8192)}`,
      }),
  });
  await assert.rejects(ledger.readContract(job.issue), /8 KB/u);
});

test('failed Paperclip responses check status before bounded error-body reads', async () => {
  let statusChecked = false;
  let bodyReads = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(8193));
    },
    cancel() {
      cancelled = true;
    },
  });
  const failure = {
    get ok() {
      statusChecked = true;
      return false;
    },
    status: 502,
    get body() {
      assert.equal(statusChecked, true);
      bodyReads += 1;
      return body;
    },
  } as unknown as Response;
  const ledger = createLedger({
    apiUrl: 'http://paperclip.test',
    token: 'fixture-token',
    session: 'session-7',
    fetch: async () => failure,
  });

  await assert.rejects(ledger.readContract(job.issue), /502/u);
  assert.equal(bodyReads, 1);
  assert.equal(cancelled, true);
});

test('oversized Paperclip responses are refused before parsing', async () => {
  const ledger = createLedger({
    apiUrl: 'http://paperclip.test',
    token: 'fixture-token',
    session: 'session-7',
    fetch: async () =>
      new Response(
        JSON.stringify({ ...issue(), title: 'x'.repeat(1_048_577) }),
        { headers: { 'content-type': 'application/json' } },
      ),
  });
  await assert.rejects(ledger.readContract(job.issue), /1 MiB/u);
});

test('a timed-out pre-write board read refuses without a PATCH', async () => {
  let requests = 0;
  let patches = 0;
  const ledger = createLedger({
    apiUrl: 'http://paperclip.test',
    token: 'fixture-token',
    session: 'session-7',
    requestTimeoutMs: 5,
    fetch: async (_input, init) => {
      requests += 1;
      if (requests === 1) return response(issue());
      if (init?.method === 'PATCH') patches += 1;
      return new Promise<Response>((_resolve, reject) => {
        if (!init?.signal) {
          setTimeout(() => reject(new Error('simulated request timeout')), 5);
          return;
        }
        init.signal.addEventListener(
          'abort',
          () => reject(new Error('simulated request timeout')),
          { once: true },
        );
      });
    },
  });
  const contract = await ledger.readContract(job.issue);
  let result: string | undefined;
  await assert.doesNotReject(async () => {
    result = await ledger.submitForReview(job, contract, evidence(), sha);
  });
  assert.equal(result, 'refused');
  assert.equal(patches, 0);
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

test('pre-write revision drift refuses with board_changed and makes no write', async () => {
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
    'board_changed',
  );
  assert.equal(writes.length, 0);
});

test('concurrent done is never overwritten by a second status write', async () => {
  const activities: Array<Record<string, unknown>> = [];
  const patches: Array<{ status: string; comment: string }> = [];
  const comments: string[] = [];
  let status = 'in_progress';
  const ledger = createLedger({
    apiUrl: 'http://paperclip.test',
    token: 'fixture-token',
    session: 'session-7',
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/activity')) return response(activities);
      if (path.endsWith('/comments') && init?.method === 'POST') {
        comments.push((JSON.parse(String(init.body)) as { body: string }).body);
        return response({ id: 'comment-1' }, 201);
      }
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as {
          status: string;
          comment: string;
        };
        patches.push(body);
        if (body.status === 'in_review') {
          status = body.status;
          activities.push({
            id: 'ledger-update',
            action: 'issue.updated',
            entityId: job.issue,
            createdAt: '2026-10-08T10:00:00.002Z',
            details: { status: 'in_review', source: 'comment' },
          });
          const receipt = response(issue(undefined, status));
          status = 'done';
          activities.push({
            id: 'concurrent-update',
            action: 'issue.updated',
            entityId: job.issue,
            createdAt: '2026-10-08T10:00:00.003Z',
            details: {
              status: 'done',
              changes: { status: { from: 'in_review', to: 'done' } },
            },
          });
          return receipt;
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
    ['in_review'],
  );
  assert.equal(comments.length, 1);
  assert.match(comments[0] ?? '', /status=in_review/);
  assert.match(comments[0] ?? '', new RegExp(sha));
  assert.match(comments[0] ?? '', /2026-10-08T10:00:00.000Z/);
  assert.match(comments[0] ?? '', /issue.updated at 2026-10-08T10:00:00.003Z/);
  assert.match(comments[0] ?? '', /"to":"done"/);
  assert.equal(status, 'done');
});

function replayFixture(
  mode:
    | 'crash-before-reconcile'
    | 'comment-rejected'
    | 'comment-response-lost'
    | 'comment-rejected-pagination-ambiguous',
) {
  const activities: Array<Record<string, unknown>> = [];
  const comments: Array<{ body: string; createdAt: string }> = [];
  let status = 'in_progress';
  let updatedAt = '2026-10-08T10:00:00.000Z';
  let activityReads = 0;
  let reviewWrites = 0;
  let conflictWrites = 0;
  const ledger = createLedger({
    session: 'session-7',
    transport: {
      readIssue: async () => ({ ...issue(updatedAt, status) }),
      readActivity: async () => {
        activityReads += 1;
        if (mode === 'crash-before-reconcile' && activityReads === 2)
          throw new Error('simulated crash after the durable PATCH receipt');
        return activities;
      },
      readComments: async () =>
        mode === 'comment-rejected-pagination-ambiguous'
          ? { comments, nextCursor: 'page-2' }
          : comments,
      createComment: async (_issueId, comment) => {
        conflictWrites += 1;
        if (
          (mode === 'comment-rejected' ||
            mode === 'comment-rejected-pagination-ambiguous') &&
          conflictWrites === 1
        )
          throw new Error('simulated definite comment rejection');
        if (mode === 'comment-response-lost' && conflictWrites === 1) {
          comments.push({ body: comment, createdAt: new Date().toISOString() });
          throw new Error('simulated accepted comment with lost response');
        }
        comments.push({ body: comment, createdAt: new Date().toISOString() });
        return { id: `conflict-${conflictWrites}` };
      },
      updateIssue: async (_issueId, nextStatus, comment) => {
        reviewWrites += 1;
        status = nextStatus;
        updatedAt = new Date().toISOString();
        const createdAt = updatedAt;
        comments.push({ body: comment, createdAt });
        activities.push(
          {
            id: `review-status-${reviewWrites}`,
            action: 'issue.updated',
            entityId: job.issue,
            createdAt,
            details: { status: 'in_review' },
          },
          {
            id: `review-comment-${reviewWrites}`,
            action: 'comment.created',
            entityId: job.issue,
            createdAt,
            details: { body: comment },
          },
        );
        if (mode !== 'crash-before-reconcile')
          activities.push({
            id: `foreign-comment-${reviewWrites}`,
            action: 'comment.created',
            entityId: job.issue,
            createdAt,
            details: { body: 'human activity after the review PATCH' },
          });
        return issue(updatedAt, status);
      },
    },
  });
  return {
    ledger,
    activities,
    comments,
    counts: () => ({ reviewWrites, conflictWrites }),
    addForeignActivity() {
      activities.push({
        id: 'foreign-after-receipt',
        action: 'comment.created',
        entityId: job.issue,
        createdAt: new Date().toISOString(),
        details: { body: 'human activity after the review PATCH' },
      });
    },
  };
}

test('same-SHA replay reconciles foreign activity after a persisted PATCH receipt', async () => {
  const fixture = replayFixture('crash-before-reconcile');
  const contract = await fixture.ledger.readContract(job.issue);
  const receipts: unknown[] = [];
  await assert.rejects(
    fixture.ledger.submitForReview(job, contract, evidence(), sha, {
      onSubmitted: (receipt) => receipts.push(receipt),
    }),
    /simulated crash/u,
  );
  assert.equal(receipts.length, 1, 'the PATCH receipt was already observed');
  fixture.addForeignActivity();

  const replay = await fixture.ledger.submitForReview(
    job,
    contract,
    evidence(),
    sha,
    { reconcile: true },
  );

  assert.equal(replay, 'board_conflict');
  assert.deepEqual(fixture.counts(), { reviewWrites: 1, conflictWrites: 1 });
  assert.equal(
    fixture.comments.filter((comment) =>
      comment.body.includes('Board conflict after'),
    ).length,
    1,
  );
});

test('same-SHA replay retries a definitely rejected conflict comment without another PATCH', async () => {
  const fixture = replayFixture('comment-rejected');
  const contract = await fixture.ledger.readContract(job.issue);
  await assert.rejects(
    fixture.ledger.submitForReview(job, contract, evidence(), sha),
    /definite comment rejection/u,
  );

  const replay = await fixture.ledger.submitForReview(
    job,
    contract,
    evidence(),
    sha,
    { reconcile: true },
  );

  assert.equal(replay, 'board_conflict');
  assert.deepEqual(fixture.counts(), { reviewWrites: 1, conflictWrites: 2 });
  assert.equal(
    fixture.comments.filter((comment) =>
      comment.body.includes('Board conflict after'),
    ).length,
    1,
  );
});

test('same-SHA replay detects an accepted conflict comment after its response is lost', async () => {
  const fixture = replayFixture('comment-response-lost');
  const contract = await fixture.ledger.readContract(job.issue);
  await assert.rejects(
    fixture.ledger.submitForReview(job, contract, evidence(), sha),
    /lost response/u,
  );

  const replay = await fixture.ledger.submitForReview(
    job,
    contract,
    evidence(),
    sha,
    { reconcile: true },
  );

  assert.equal(replay, 'board_conflict');
  assert.deepEqual(fixture.counts(), { reviewWrites: 1, conflictWrites: 1 });
  assert.equal(
    fixture.comments.filter((comment) =>
      comment.body.includes('Board conflict after'),
    ).length,
    1,
  );
});

test('ambiguous comment pagination leaves conflict delivery pending without another write', async () => {
  const fixture = replayFixture('comment-rejected-pagination-ambiguous');
  const contract = await fixture.ledger.readContract(job.issue);
  await assert.rejects(
    fixture.ledger.submitForReview(job, contract, evidence(), sha),
    /definite comment rejection/u,
  );

  const replay = await fixture.ledger.submitForReview(
    job,
    contract,
    evidence(),
    sha,
    { reconcile: true },
  );

  assert.equal(replay, 'board_conflict');
  assert.deepEqual(fixture.counts(), { reviewWrites: 1, conflictWrites: 1 });
  assert.equal(
    fixture.comments.filter((comment) =>
      comment.body.includes('Board conflict after'),
    ).length,
    0,
  );
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

test('KRN_SESSION override must match the verified commit trailer', async () => {
  let writes = 0;
  const ledger = createLedger({
    apiUrl: 'http://paperclip.test',
    token: 'fixture-token',
    session: 'different-session',
    fetch: async (_input, init) => {
      if (init?.method) writes += 1;
      return response(issue());
    },
  });
  const contract = await ledger.readContract(job.issue);
  assert.equal(
    await ledger.submitForReview(job, contract, evidence(), sha, {
      session: 'trailer-session',
    }),
    'refused',
  );
  assert.equal(writes, 0);
});

test('review uses one in_review PATCH with SHA, check hashes, and session comment', async () => {
  const writes: Request[] = [];
  const activities: Array<Record<string, unknown>> = [];
  let status = 'in_progress';
  let updatedAt = '2026-10-08T10:00:00.000Z';
  const ledger = createLedger({
    apiUrl: 'http://paperclip.test',
    token: 'fixture-token',
    session: 'session-7',
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/activity')) return response(activities);
      if (init?.method === 'PATCH') {
        writes.push(new Request('http://paperclip.test', init));
        const body = JSON.parse(String(init.body)) as { comment: string };
        status = 'in_review';
        updatedAt = new Date().toISOString();
        activities.push(
          {
            id: 'ledger-update',
            action: 'issue.updated',
            entityId: job.issue,
            createdAt: updatedAt,
            details: { status: 'in_review', source: 'comment' },
          },
          {
            id: 'ledger-comment',
            action: 'issue.commented',
            entityId: job.issue,
            createdAt: updatedAt,
            details: { body: body.comment },
          },
        );
      }
      return response({ ...issue(updatedAt, status), updatedAt });
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

test('post-write reconciliation recognizes the paired update and exact comment', async () => {
  const activities: Array<Record<string, unknown>> = [];
  const comments: string[] = [];
  let status = 'in_progress';
  let updatedAt = '2026-10-08T10:00:00.000Z';
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
        status = body.status;
        comments.push(body.comment);
        updatedAt = new Date().toISOString();
        activities.push(
          {
            id: 'own-status-change',
            action: 'issue.updated',
            entityId: job.issue,
            createdAt: updatedAt,
            details: {
              changes: { status: { from: 'in_progress', to: 'in_review' } },
            },
          },
          {
            id: 'own-comment',
            action: 'issue.commented',
            entityId: job.issue,
            createdAt: updatedAt,
            details: { body: body.comment },
          },
        );
      }
      return response({ ...issue(updatedAt, status), updatedAt });
    },
  });
  const contract = await ledger.readContract(job.issue);
  assert.equal(
    await ledger.submitForReview(job, contract, evidence(), sha),
    'submitted',
  );
  assert.equal(comments.length, 1);
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
    'board_changed',
  );
  assert.equal(writes.length, 0);
});
