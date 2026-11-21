import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  type BrainRecord,
  BUDGET,
  brainPacket,
  parseRecords,
} from '../../src/brain/packet.ts';

const raw = JSON.parse(
  readFileSync(
    new URL('../fixtures/conventions.json', import.meta.url),
    'utf8',
  ),
);
const records = parseRecords(raw);
const BASE_DATE = '2026-11-08';

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
  assert.throws(
    () => parseRecords([{ ...record({}), tags: [] }]),
    /Unrecognized key/u,
  );
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

test('the match threshold drops a one-term match, also of a research-candidate trial record, but keeps a record proposed from a graded failure', () => {
  const text = 'parser output is formatted';
  const served = (over: Partial<BrainRecord>) =>
    brainPacket({
      task: 't',
      query: 'parser',
      records: [record({ id: 'r-one', text, ...over })],
      asOf: '2026-11-01',
      budget: 400,
      minMatch: 2,
    }).records;
  assert.deepEqual(served({}), []);
  assert.deepEqual(
    served({ source: 'krn standards propose --from-candidate' }),
    [],
  );
  assert.deepEqual(served({ gradedFailure: true }), ['r-one']);
});

test('a hidden-test evidence record parsed from the store carries the graded-failure mark, a record without it does not', () => {
  const base = {
    id: 'trial-hidden-test-abc',
    type: 'pitfall',
    text: 'parser output is formatted',
    audience: 'worker',
    enforcement: { kind: 'advisory' },
    provenance: { origin: 'test', evidence: ['x'], proposals: [] },
    status: 'trial',
    recorded_at: '2026-10-01',
    valid_from: '2026-10-01',
    valid_to: null,
    supersedes: [],
    subject: 'parser',
    review_by: '2026-11-01',
  };
  const [graded, candidate] = parseRecords([
    { ...base, evidence_kind: 'hidden-test' },
    { ...base, id: 'trial-candidate-abc', subject: 'other' },
  ]);
  assert.equal(graded?.gradedFailure, true);
  assert.equal(candidate?.gradedFailure, undefined);
});
