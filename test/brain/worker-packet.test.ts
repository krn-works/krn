import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import { parseRecords } from '../../src/brain/packet.ts';
import {
  lanePacket,
  packetBrief,
  workerRecords,
} from '../../src/brain/worker-packet.ts';
import { contractConventions } from '../../src/repo/contract.ts';

const repo = join(import.meta.dirname, '../..');
const brief =
  'You are working on task t-abc1234. Add to src/cli/slug.ts a function slugify, with a node:test file under test/. Commit your work when it is done.';

test('the lane brief starts with the packet and keeps the lead brief intact', () => {
  const packet = lanePacket(repo, brief, '2026-11-08', 'lane');
  assert.ok(packet !== null && packet.records.length > 0);
  // The lane packet stays within the measured 400-token budget.
  assert.equal(packet.budget, 400);
  assert.ok(packet.tokens <= packet.budget, `${packet.tokens} tokens`);
  assert.ok(
    packet.records.every((id) => id.startsWith('r-')),
    packet.records.join(),
  );
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
  const packet = lanePacket(repo, 'ok', '2026-11-08', 'lane');
  assert.deepEqual(packet?.records, []);
  assert.equal(packetBrief(packet, 'ok'), 'ok');
});

test('a repository without conventions gets no packet', (t) => {
  const bare = mkdtempSync(join(tmpdir(), 'krn-worker-packet-'));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.equal(lanePacket(bare, brief, '2026-11-08', 'lane'), null);
  assert.equal(packetBrief(null, brief), brief);
});

test('KRN keeps its conventions in its own tracked file, not in the frozen FR-40 material', () => {
  const file = contractConventions(repo);
  assert.equal(file, '.agents/conventions.json');
  const tracked = spawnSync(
    'git',
    ['-C', repo, 'ls-files', '--error-unmatch', file],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(tracked.status, 0, tracked.stderr);
  parseRecords(JSON.parse(readFileSync(join(repo, file), 'utf8')));
});

test('KRN states the biome rule with npm run fast and generated files in its lane packet', () => {
  const frozen = readFileSync(join(repo, 'evals/fr40/records.json'), 'utf8');
  assert.ok(!frozen.includes('not only your own tests'));
  const packet = lanePacket(repo, `${brief} Run biome.`, '2026-11-11', 'lane');
  if (packet === null) throw new Error('no packet');
  assert.ok(packet.records.includes('r-biome-clean'));
  const biome = packet.text
    .split('\n')
    .find((l) => l.startsWith('- [r-biome-clean]'));
  assert.match(biome ?? '', /before every commit run npm run fast/u);
  assert.match(biome ?? '', /not only your own tests/u);
  assert.match(biome ?? '', /scripts\/lib\/shard-weights\.mjs/u);
});

test('the brain area holds no KRN-only record ids, live-records path or FR-40 import', () => {
  const found = spawnSync(
    'git',
    [
      '-C',
      repo,
      'grep',
      '-n',
      '-E',
      '-e',
      'live-records|MEASURED|LEAD_ONLY',
      // An import of the FR-40 material in any module form; prose may still cite the experiment.
      '-e',
      "(from|import\\(?) *'[^']*evals/",
      '--',
      'src/brain',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(found.stdout, '');
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

test('a record addressed to the lead never enters the lane packet', (t) => {
  // Plain hand-written conventions JSON, exactly as a repository would keep it.
  const root = mkdtempSync(join(tmpdir(), 'krn-audience-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.krn'));
  writeFileSync(
    join(root, '.krn/conventions.json'),
    `[
  {"id": "r-lead", "type": "convention", "text": "Format the parser tracker with biome.", "recorded_at": "2026-01-01", "valid_from": "2026-01-01", "valid_to": null, "source": "AGENTS.md", "audience": "lead"},
  {"id": "r-worker", "type": "convention", "text": "Format the parser with biome.", "recorded_at": "2026-01-01", "valid_from": "2026-01-01", "valid_to": null, "source": "AGENTS.md", "audience": "worker"},
  {"id": "r-all", "type": "convention", "text": "Format the parser tests with biome.", "recorded_at": "2026-01-01", "valid_from": "2026-01-01", "valid_to": null, "source": "AGENTS.md"}
]
`,
  );
  const packet = lanePacket(
    root,
    'format the parser tracker tests',
    '2026-11-13',
    'u',
  );
  assert.deepEqual([...(packet?.records ?? [])].sort(), ['r-all', 'r-worker']);
  assert.deepEqual(
    workerRecords([
      row('a', 'x', null),
      { ...row('b', 'y', null), audience: 'lead' },
    ]).map((r) => r.id),
    ['a'],
  );
});

test('an audience other than lead or worker is refused', () => {
  assert.throws(
    () => parseRecords([{ ...row('r-x', 'x', null), audience: 'everyone' }]),
    /audience: expected lead or worker/u,
  );
});
