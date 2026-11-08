import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  MEASURED,
  packetBrief,
  workerPacket,
} from '../../src/brain/worker-packet.ts';

const repo = join(import.meta.dirname, '../..');
const brief =
  'You are working on task t-abc1234. Add to src/cli/slug.ts a function slugify, with a node:test file under test/. Commit your work when it is done.';

test('a worker packet selects only the seven measured conventions', () => {
  const packet = workerPacket(repo, brief, '2026-11-08');
  assert.ok(packet !== null && packet.records.length > 0);
  for (const id of packet.records)
    assert.ok((MEASURED as readonly string[]).includes(id), id);
  assert.ok(packet.records.includes('r-commit-title-id'));
  assert.ok(packet.tokens <= packet.budget);
});

test('the worker brief starts with the packet and keeps the lead brief intact', () => {
  const packet = workerPacket(repo, brief, '2026-11-08');
  assert.ok(packet !== null);
  const text = packetBrief(packet, brief);
  assert.ok(
    text.startsWith(
      `Repository conventions (brain packet ${packet.sha256.slice(0, 12)}):\n`,
    ),
  );
  assert.ok(text.includes(packet.text));
  assert.ok(text.endsWith(`\n\n${brief}`));
});

test('a brief with no matching convention passes through unchanged', () => {
  const packet = workerPacket(repo, 'ok', '2026-11-08');
  assert.deepEqual(packet?.records, []);
  assert.equal(packetBrief(packet, 'ok'), 'ok');
});

test('a repository without measured records gets no packet', (t) => {
  const bare = mkdtempSync(join(tmpdir(), 'krn-worker-packet-'));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.equal(workerPacket(bare, brief, '2026-11-08'), null);
  assert.equal(packetBrief(null, brief), brief);
});
