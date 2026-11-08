import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BASE_DATE, generate } from '../../evals/fr40/tasks.ts';
import { BUDGET, fr40Packet } from '../../src/brain/cli.ts';
import {
  type BrainRecord,
  brainPacket,
  parseRecords,
  tokens,
} from '../../src/brain/packet.ts';

const raw = JSON.parse(
  readFileSync(
    new URL('../../evals/fr40/records.json', import.meta.url),
    'utf8',
  ),
);
const records = parseRecords(raw);
const tasks = generate();

const record = (over: Partial<BrainRecord>): BrainRecord => ({
  id: 'r-x',
  type: 'rule',
  text: 'commit titles end with the task id',
  recorded_at: '2026-10-01',
  valid_from: '2026-10-01',
  valid_to: null,
  source: 'AGENTS.md',
  ...over,
});

test('reviewed records have the ADR 0002 shape and predate the task base', () => {
  assert.ok(records.length >= 7);
  for (const r of records) assert.ok(r.recorded_at <= BASE_DATE, r.id);
});

test('parseRecords rejects extra fields, bad dates and duplicate ids', () => {
  assert.throws(() => parseRecords([{ ...record({}), tags: [] }]), /exactly/u);
  assert.throws(
    () => parseRecords([record({ recorded_at: '2026/10/01' })]),
    /YYYY-MM-DD/u,
  );
  assert.throws(() => parseRecords([record({}), record({})]), /duplicate/u);
  assert.throws(
    () => parseRecords([record({ valid_to: '2026-09-01' })]),
    /precedes/u,
  );
});

test('a brain packet holds only records known at the as-of date', () => {
  const packet = brainPacket({
    task: 't',
    query: 'commit titles task id',
    records: [
      record({ id: 'r-known' }),
      record({
        id: 'r-later',
        recorded_at: '2026-11-09',
        valid_from: '2026-11-09',
      }),
      record({ id: 'r-expired', valid_to: '2026-10-31' }),
    ],
    asOf: '2026-11-08',
    budget: BUDGET,
  });
  assert.deepEqual(packet.records, ['r-known']);
});

test('both arms share one budget and stay within it for every task', () => {
  const statics = new Set<string>();
  for (const task of tasks) {
    const brain = fr40Packet(task.id, 'brain');
    const fixed = fr40Packet(task.id, 'static');
    assert.equal(brain.budget, BUDGET);
    assert.equal(fixed.budget, BUDGET);
    assert.ok(brain.tokens <= BUDGET, `${task.id} brain ${brain.tokens}`);
    assert.ok(fixed.tokens <= BUDGET, `${task.id} static ${fixed.tokens}`);
    assert.ok(fixed.tokens >= BUDGET - 10, `${task.id} static underfilled`);
    assert.equal(tokens(brain.text), brain.tokens);
    assert.ok(brain.records.length > 0, `${task.id} selected nothing`);
    assert.equal(brain.asOf, BASE_DATE);
    statics.add(fixed.text);
  }
  assert.equal(statics.size, 1, 'static material differs between tasks');
});

test('packets for every task build deterministically', () => {
  for (const task of tasks)
    for (const arm of ['brain', 'static'] as const)
      assert.equal(
        fr40Packet(task.id, arm).sha256,
        fr40Packet(task.id, arm).sha256,
        `${task.id} ${arm}`,
      );
});

test('no packet leaks a scorer answer: task ids, tracker ids or dates', () => {
  for (const task of tasks)
    for (const arm of ['brain', 'static'] as const) {
      const { text } = fr40Packet(task.id, arm);
      assert.ok(!text.includes(task.taskId), `${task.id} ${arm} names its id`);
      assert.doesNotMatch(text, /\bt-[0-9a-z]{7}\b/u, `${task.id} ${arm}`);
      assert.ok(!text.includes(task.date), `${task.id} ${arm} names its date`);
    }
});

test('an unknown task id is a usage error', () => {
  assert.throws(
    () => fr40Packet('fr40-none', 'brain'),
    (error: Error & { exitCode?: number }) => error.exitCode === 64,
  );
});
