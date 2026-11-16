import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { brainPacket, packetRecord } from '../../src/brain/packet.ts';
import { parseUnified } from '../../src/brain/record.ts';

const root = new URL('../../', import.meta.url).pathname;
const evalRun = new URL('../../evals/retrieval/run.ts', import.meta.url)
  .pathname;

const served = [
  'standards/records.json',
  '.agents/records.json',
  '.agents/standards.json',
];
const rows = served.flatMap((file) =>
  parseUnified(JSON.parse(readFileSync(`${root}${file}`, 'utf8'))),
);
const inForce = rows.filter(
  (row) => row.valid_to === null && row.status !== 'retired',
);

test('every in-force served record carries retrieval terms', () => {
  assert.ok(inForce.length > 100);
  const bare = inForce
    .filter((row) => row.applies.terms.length === 0)
    .map((row) => row.id);
  assert.deepEqual(bare, []);
});

test('a record is served for a task that uses one of its terms the text lacks', () => {
  const [plain, keyed] = parseUnified([
    {
      id: 'x-plain',
      type: 'standard',
      text: 'Keep notes tidy.',
      recorded_at: '2026-01-01',
      valid_from: '2026-01-01',
      valid_to: null,
      source: 'test',
    },
    {
      id: 'x-keyed',
      type: 'standard',
      text: 'Keep notes tidy.',
      applies: { terms: ['trailer'] },
      recorded_at: '2026-01-01',
      valid_from: '2026-01-01',
      valid_to: null,
      source: 'test',
    },
  ]).map(packetRecord);
  assert.ok(plain && keyed);
  const packet = brainPacket({
    task: 'probe',
    query: 'fix the commit trailer',
    records: [plain, keyed],
    asOf: '2026-06-01',
    budget: 400,
  });
  assert.deepEqual(packet.records, ['x-keyed']);
});

test('cases.json holds 30 mined cases that name records in force', () => {
  const file = JSON.parse(
    readFileSync(`${root}evals/retrieval/cases.json`, 'utf8'),
  ) as { cases: { source: string; violated: string[] }[] };
  assert.equal(file.cases.length, 30);
  const known = new Set(rows.map((row) => row.id));
  for (const item of file.cases) {
    assert.match(item.source, /^[0-9a-f]{12}$/u);
    assert.ok(item.violated.length > 0);
    for (const id of item.violated) assert.ok(known.has(id), id);
  }
});

test('the eval prints recall@5 per moment and reaches 0.6 at task start', () => {
  const run = spawnSync('node', [evalRun], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split('\n');
  assert.deepEqual(
    lines.map((line) => line.split(' ')[1]),
    ['task-start', 'query', 'edit'],
  );
  const start = /^recall@5 task-start (\d\.\d\d) /u.exec(lines[0] ?? '');
  assert.ok(start, lines[0]);
  assert.ok(Number(start[1]) >= 0.6, lines[0]);
});

test('the eval metric flag prints one number and an unknown metric exits 64', () => {
  const one = spawnSync(
    'node',
    [evalRun, '--metric', 'recall-at-5-task-start'],
    { encoding: 'utf8' },
  );
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /^\d\.\d\d\n$/u);
  const bad = spawnSync('node', [evalRun, '--metric', 'nope'], {
    encoding: 'utf8',
  });
  assert.equal(bad.status, 64);
});
