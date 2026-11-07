import assert from 'node:assert/strict';
import test from 'node:test';
import { analyze, parseLine } from '../../scripts/idle-gap-cache.mjs';

const compactLine =
  '{"type":"system","subtype":"compact_boundary","timestamp":"2026-10-26T17:30:00.000Z","compactMetadata":{"trigger":"auto","preTokens":969967,"postTokens":29390}}';
const turnLine = (ts: string, id: string, write: number, read: number) =>
  `{"type":"assistant","isSidechain":false,"requestId":"${id}","timestamp":"${ts}","message":{"usage":{"input_tokens":2,"cache_creation_input_tokens":${write},"cache_read_input_tokens":${read}}}}`;

test('parses a verbatim compact_boundary line', () => {
  assert.deepEqual(parseLine(compactLine), {
    kind: 'compact',
    ts: Date.parse('2026-10-26T17:30:00.000Z'),
    trigger: 'auto',
    pre: 969967,
    post: 29390,
  });
});

test('counts cache writes only on turns after a gap over the ttl', () => {
  const records = [
    turnLine('2026-10-26T17:00:00.000Z', 'a', 100, 0),
    turnLine('2026-10-26T17:00:30.000Z', 'b', 10, 100),
    turnLine('2026-10-26T17:10:30.000Z', 'c', 500, 0),
  ].map(parseLine);
  const s = analyze(records, 300);
  assert.equal(s.turns, 3);
  assert.equal(s.gaps, 1);
  assert.equal(s.gapWrite, 500);
  assert.equal(analyze(records, 3600).gaps, 0);
});
