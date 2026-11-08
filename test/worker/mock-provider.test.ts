import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assistantReply } from '../../scripts/codex/mock-responses.ts';
import { report, requests, run } from './mock-provider-fixture.ts';

test('the real codex app-server runs a worker turn against a mock Responses provider', async (t) => {
  const { played, provider } = await run(
    t,
    {
      name: 'mock-provider',
      question:
        'Does one worker turn reach the provider and end with its report?',
      steps: [
        {
          command: 'start',
          text: 'Do not change files.\nReturn a complete worker report.',
          exit: 0,
        },
        { command: 'stop', exit: 0 },
      ],
    },
    [assistantReply('resp-1', report)],
  );
  // One turn is one streamed request with the brief and the report schema.
  assert.deepEqual(requests(provider), ['POST /v1/responses']);
  const turn = provider.requests[0]?.body as {
    model?: string;
    stream?: boolean;
    text?: { format?: { type?: string } };
  };
  assert.equal(turn.model, 'gpt-6-luna');
  assert.equal(turn.stream, true);
  assert.equal(turn.text?.format?.type, 'json_schema');
  assert.match(JSON.stringify(turn), /Return a complete worker report\./u);
  const written = JSON.parse(
    readFileSync(join(played.run, 'rounds/001/report.json'), 'utf8'),
  );
  assert.equal(written.summary, 'mock provider answered');
});
