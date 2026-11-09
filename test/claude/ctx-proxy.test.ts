import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createProxy,
  shadowClear,
  UPSTREAM,
} from '../../scripts/claude/ctx-proxy.ts';

const big = 'x'.repeat(2000);
const listen = (server: http.Server): Promise<number> =>
  new Promise((ok) =>
    server.listen(0, '127.0.0.1', () =>
      ok((server.address() as AddressInfo).port),
    ),
  );

function conversation(uses: number) {
  const messages: unknown[] = [{ role: 'user', content: 'start' }];
  for (let i = 0; i < uses; i++) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `u${i}`, name: 'Bash', input: {} }],
    });
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `u${i}`,
          content: i === 0 ? 'small' : big,
        },
      ],
    });
  }
  return { model: 'm', messages };
}

const sse =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":7,"cache_creation_input_tokens":3,"output_tokens":1}}}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n';

test('production upstream is pinned to api.anthropic.com', () => {
  assert.equal(UPSTREAM, 'https://api.anthropic.com');
});

test('shadowClear skips recent uses and results under 1 KB', () => {
  const s = shadowClear(conversation(10), 8);
  assert.equal(s.toolResults, 10);
  // u0 is old but small; u1 is old and big; u2..u9 are the last eight.
  assert.equal(s.wouldClearBytes, Buffer.byteLength(JSON.stringify(big)));
});

test('proxy streams byte-identically, forwards headers, records metrics', async () => {
  let seen: http.IncomingHttpHeaders = {};
  let seenBody = '';
  const fake = http.createServer((req, res) => {
    seen = req.headers;
    seenBody = '';
    req.on('data', (c) => {
      seenBody += c;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse.slice(0, 50));
      setTimeout(() => res.end(sse.slice(50)), 10);
    });
  });
  const fakePort = await listen(fake);
  const dir = mkdtempSync(join(tmpdir(), 'ctx-proxy-'));
  const metricsPath = join(dir, 'm.jsonl');
  let clock = 1_000_000;
  const proxy = createProxy({
    upstream: `http://127.0.0.1:${fakePort}`,
    metricsPath,
    now: () => clock,
  });
  const port = await listen(proxy);
  const payload = JSON.stringify(conversation(10));
  const call = async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer SECRET-TOKEN-VALUE',
        'x-api-key': 'SECRET-KEY-VALUE',
        'x-claude-code-session-id': 'sess-abc',
        'content-type': 'application/json',
        'accept-encoding': 'gzip',
      },
      body: payload,
    });
    return r.text();
  };
  assert.equal(await call(), sse);
  clock += 400_000;
  assert.equal(await call(), sse);
  assert.equal(seenBody, payload);
  assert.equal(seen.authorization, 'Bearer SECRET-TOKEN-VALUE');
  assert.equal(seen['x-api-key'], 'SECRET-KEY-VALUE');
  assert.equal(seen['x-claude-code-session-id'], 'sess-abc');
  assert.equal(seen['accept-encoding'], undefined);

  const raw = readFileSync(metricsPath, 'utf8');
  assert.ok(!raw.includes('SECRET'));
  assert.ok(!raw.includes('sess-abc'));
  const [first, second] = raw
    .split('\n')
    .slice(0, -1)
    .map((l) => JSON.parse(l));
  assert.equal(first.input_tokens, 5);
  assert.equal(first.cache_read_tokens, 7);
  assert.equal(first.cache_creation_tokens, 3);
  assert.equal(first.output_tokens, 42);
  assert.equal(first.model, 'm');
  assert.equal(first.request_bytes, Buffer.byteLength(payload));
  assert.equal(first.tool_result_count, 10);
  assert.equal(first.would_clear_bytes, Buffer.byteLength(JSON.stringify(big)));
  assert.equal(
    first.would_clear_tokens,
    Math.round(first.would_clear_bytes / 4),
  );
  assert.equal(first.gap_s, null);
  assert.equal(first.cold, false);
  assert.equal(second.gap_s, 400);
  assert.equal(second.cold, true);
  assert.equal(second.session, first.session);

  const health = await fetch(`http://127.0.0.1:${port}/krn-health`);
  assert.equal(health.status, 200);
  proxy.closeAllConnections();
  proxy.close();
  fake.closeAllConnections();
  fake.close();
});
