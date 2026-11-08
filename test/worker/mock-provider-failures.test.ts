import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assistantReply } from '../../scripts/codex/mock-responses.ts';
import { inbound, report, requests, run } from './mock-provider-fixture.ts';

// Failure frames the real codex app-server writes when the mock provider
// answers with an error (scripts/codex/mock-responses.ts).

test('a 429 usage_limit_reached reply fails the turn as a retryable usageLimitExceeded', async (t) => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const { provider, frames, result } = await run(
    t,
    {
      name: 'usage-limit',
      question: 'How does a turn end when the provider reports a usage limit?',
      steps: [
        {
          command: 'start',
          text: 'Return a complete worker report.',
          exit: 75,
        },
        { command: 'stop', exit: 0 },
      ],
    },
    [
      {
        status: 429,
        body: {
          error: {
            type: 'usage_limit_reached',
            message: 'mock usage limit',
            plan_type: 'plus',
            resets_at: resetsAt,
          },
        },
        headers: {
          'x-codex-primary-used-percent': '100',
          'x-codex-primary-window-minutes': '300',
          'x-codex-primary-reset-at': String(resetsAt),
        },
      },
    ],
  );
  // request_max_retries = 0: the 429 reaches the turn unretried.
  assert.deepEqual(requests(provider), ['POST /v1/responses']);
  const [completed] = inbound(frames, 'turn/completed');
  assert.equal(completed?.params.turn.status, 'failed');
  assert.equal(
    completed?.params.turn.error.codexErrorInfo,
    'usageLimitExceeded',
  );
  // Without an account, account/rateLimits/read is refused and the reset
  // time stays unknown; the reply's reset reaches the client only through
  // account/rateLimits/updated, which carries account state and stays
  // opted out (test/rules/capture-privacy-guard.test.mjs).
  const read = frames.findIndex((line) =>
    line.includes('"method":"account/rateLimits/read"'),
  );
  assert.ok(read > 0, 'a limit failure reads the rate limits');
  assert.match(frames[read + 1] ?? '', /"code":-32600/u);
  const written = result('001');
  assert.deepEqual(written.failure, {
    class: 'usageLimitExceeded',
    retryable: true,
  });
  assert.equal(written.message, 'worker turn failed: usageLimitExceeded');
  assert.doesNotMatch(
    JSON.stringify(written),
    /usage limit/iu,
    'result.json carries provider text',
  );
});

test('a provider error during a forced compaction fails the round with the compaction turn class', async (t) => {
  const { provider, frames, result } = await run(
    t,
    {
      name: 'failed-compaction',
      question: 'How does a round end when its compaction turn fails?',
      steps: [
        { command: 'start', text: 'Return a complete worker report.', exit: 0 },
        {
          command: 'send',
          text: 'Return a complete worker report.',
          flags: ['--compact', 'always'],
          exit: 75,
        },
        { command: 'stop', exit: 0 },
      ],
    },
    [
      assistantReply('resp-1', report),
      { status: 500, body: { error: { message: 'mock compaction failure' } } },
    ],
  );
  // The second request is the compaction itself; the round's own turn never starts.
  assert.deepEqual(requests(provider), [
    'POST /v1/responses',
    'POST /v1/responses',
  ]);
  const compact = frames.findIndex((line) =>
    line.includes('"method":"thread/compact/start"'),
  );
  assert.ok(compact > 0, 'round 2 starts a compaction');
  assert.equal(
    frames
      .slice(compact)
      .filter((line) => line.includes('"method":"turn/start"')).length,
    0,
    'a turn started after the failed compaction',
  );
  const failed = inbound(frames, 'turn/completed').at(-1);
  assert.equal(failed?.params.turn.status, 'failed');
  assert.equal(failed?.params.turn.error.codexErrorInfo, 'internalServerError');
  const written = result('002');
  assert.deepEqual(written.failure, {
    class: 'internalServerError',
    retryable: true,
  });
  assert.equal(
    written.message,
    'worker compaction failed: internalServerError',
  );
  assert.equal(result('001').exit_code, 0);
});
