import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generate } from '../../evals/fr40/tasks.ts';
import { fr40Packet } from '../../src/brain/cli.ts';
import { brainPacket, parseRecords } from '../../src/brain/packet.ts';
import {
  applicable,
  lanePacket,
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

const tasks = generate();
const records = parseRecords(
  JSON.parse(readFileSync(join(repo, 'evals/fr40/records.json'), 'utf8')),
);
const workerSelection = (prompt: string) =>
  brainPacket({
    task: 't',
    query: prompt,
    records: applicable(records, prompt),
    asOf: '2026-11-08',
    budget: 400,
  }).records;

test('agent-state briefs keep the .krn state record and drop task-id records', () => {
  const agentState = tasks.filter((task) => task.template === 'agent-state');
  assert.equal(agentState.length, 19);
  for (const task of agentState) {
    assert.ok(fr40Packet(task.id, 'brain').records.includes('r-agent-state'));
    const chosen = workerSelection(task.prompt);
    assert.ok(
      chosen.includes('r-agent-state'),
      `${task.id} lacks r-agent-state`,
    );
    for (const id of ['r-commit-title-id', 'r-trailer', 'r-tracker-owner'])
      assert.ok(
        !chosen.includes(id),
        `${task.id} carries ${id} without a task id`,
      );
  }
});

test('a brief that names a task id keeps its task-id record', () => {
  const want = {
    'commit-title-id': 'r-commit-title-id',
    trailer: 'r-trailer',
  } as const;
  for (const task of tasks)
    if (task.template in want) {
      const id = want[task.template as keyof typeof want];
      assert.ok(
        workerSelection(task.prompt).includes(id),
        `${task.id} lacks ${id}`,
      );
    }
});

test('the live packet states the biome rule with npm run fast and generated files', () => {
  const frozen = readFileSync(join(repo, 'evals/fr40/records.json'), 'utf8');
  assert.ok(!frozen.includes('not only your own tests'));
  for (const packet of [
    workerPacket(repo, brief, '2026-11-11'),
    lanePacket(repo, `${brief} Run biome.`, '2026-11-11', 'lane'),
  ]) {
    if (packet === null) throw new Error('no packet');
    assert.ok(packet.records.includes('r-biome-clean'));
    const biome = packet.text
      .split('\n')
      .find((l) => l.startsWith('- [r-biome-clean]'));
    assert.match(biome ?? '', /before every commit run npm run fast/u);
    assert.match(biome ?? '', /not only your own tests/u);
    assert.match(biome ?? '', /scripts\/lib\/shard-weights\.mjs/u);
  }
});

test('the worker brief never carries the lead-only tracker rule', () => {
  for (const task of tasks)
    assert.ok(
      !workerSelection(task.prompt).includes('r-tracker-owner'),
      `${task.id} carries r-tracker-owner`,
    );
});

function conventionsRepo(
  t: import('node:test').TestContext,
  rows: unknown,
  contract?: string,
): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-conventions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.krn'));
  writeFileSync(join(root, '.krn/conventions.json'), JSON.stringify(rows));
  if (contract) writeFileSync(join(root, 'krn.json'), contract);
  return root;
}

const row = (id: string, text: string, valid_to: string | null) => ({
  id,
  type: 'convention',
  text,
  recorded_at: '2026-01-01',
  valid_from: '2026-01-01',
  valid_to,
  source: 'AGENTS.md',
});

test('a superseded convention never enters a packet and the live one does', (t) => {
  const root = conventionsRepo(t, [
    row('r-old', 'Format the parser with the legacy formatter.', '2026-05-01'),
    row('r-new', 'Format the parser with biome.', null),
  ]);
  const packet = lanePacket(root, 'format the parser', '2026-11-13', 'unit');
  assert.deepEqual(packet?.records, ['r-new']);
  const worker = workerPacket(root, 'format the parser', '2026-11-13');
  assert.deepEqual(worker?.records, ['r-new']);
});

test('the repo contract names the conventions file', (t) => {
  const root = conventionsRepo(
    t,
    [],
    JSON.stringify({ test: 'true', conventions: 'rules/c.json' }),
  );
  assert.equal(lanePacket(root, 'format the parser', '2026-11-13', 'u'), null);
  mkdirSync(join(root, 'rules'));
  writeFileSync(
    join(root, 'rules/c.json'),
    JSON.stringify([row('r-x', 'Format the parser with biome.', null)]),
  );
  const packet = lanePacket(root, 'format the parser', '2026-11-13', 'u');
  assert.deepEqual(packet?.records, ['r-x']);
});
