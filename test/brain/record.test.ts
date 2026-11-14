import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { brainPacket, parseRecords } from '../../src/brain/packet.ts';
import {
  parseUnified,
  RecordSchema,
  standardRecord,
} from '../../src/brain/record.ts';
import { parseStandards } from '../../src/brain/standards.ts';

const json = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));

// The plainest hand-written row: id, type, text, three dates, source.
const plain = {
  id: 'r-x',
  type: 'convention',
  text: 'Keep it small.',
  recorded_at: '2026-11-01',
  valid_from: '2026-11-01',
  valid_to: null,
  source: 'AGENTS.md',
};

test('the plainest row parses with every other field defaulted', () => {
  const [r] = parseUnified([plain]);
  assert.equal(r?.audience, 'all');
  assert.equal(r?.status, 'accepted');
  assert.equal(r?.enforcement.kind, 'advisory');
  assert.deepEqual(r?.applies, { stacks: [], needs: [], paths: [], terms: [] });
  assert.equal(r?.provenance.origin, 'AGENTS.md');
  assert.deepEqual(r?.supersedes, []);
});

test('the full schema fields are accepted and unknown ones refused', () => {
  const full = {
    id: 's-x',
    type: 'recipe',
    text: 'Do x.',
    why: 'Because.',
    audience: 'worker',
    tier: 'floor',
    applies: {
      stacks: ['node'],
      needs: ['tracker'],
      paths: ['src'],
      terms: ['x'],
    },
    enforcement: { kind: 'command', run: 'true' },
    provenance: { origin: 'o', evidence: ['#1'], proposals: ['p'] },
    status: 'trial',
    recorded_at: '2026-11-01',
    valid_from: '2026-11-01',
    valid_to: '2026-12-01',
    supersedes: ['s-old'],
  };
  assert.equal(RecordSchema.safeParse(full).success, true);
  assert.equal(RecordSchema.safeParse({ ...full, extra: 1 }).success, false);
  assert.equal(
    RecordSchema.safeParse({ ...full, type: 'note' }).success,
    false,
  );
  assert.equal(RecordSchema.safeParse({ ...full, status: 'x' }).success, false);
  assert.equal(
    RecordSchema.safeParse({ ...full, valid_to: '2026-10-01' }).success,
    false,
  );
});

test('the shipped overlay and every pack record satisfy the one schema', () => {
  const overlay = parseUnified(json('.agents/records.json'));
  assert.ok(overlay.length > 0);
  for (const raw of json('.agents/records.json') as object[])
    assert.ok('provenance' in raw && 'status' in raw, 'overlay is migrated');
  const pack = parseStandards(json('standards/records.json')).map(
    standardRecord,
  );
  assert.ok(pack.length > 4);
  assert.equal(parseUnified(pack).length, pack.length);
});

test('the packet is the same for a legacy row and its migrated form', () => {
  const [legacy] = parseRecords([{ ...plain, type: 'rule' }]);
  const migrated = parseRecords([
    {
      ...plain,
      type: 'standard',
      source: undefined,
      provenance: { origin: 'AGENTS.md', evidence: [], proposals: [] },
    },
  ]);
  const ask = (records: ReturnType<typeof parseRecords>) =>
    brainPacket({
      task: 't',
      query: 'keep it small',
      records,
      asOf: '2026-11-14',
      budget: 400,
    });
  assert.equal(ask([legacy as never]).sha256, ask(migrated).sha256);
});

test('a retired record never enters a packet', () => {
  const records = parseRecords([{ ...plain, status: 'retired' }]);
  const p = brainPacket({
    task: 't',
    query: 'keep small',
    records,
    asOf: '2026-11-14',
    budget: 400,
  });
  assert.deepEqual(p.records, []);
});
