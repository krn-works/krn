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
import { effectTotals, readExposures } from '../../src/brain/exposures.ts';
import {
  CONFIDENCE_THRESHOLD,
  parseRecords,
  SERVE_CAP,
  SERVE_POLICY,
  tokens,
} from '../../src/brain/packet.ts';
import { appliesTo } from '../../src/brain/standards.ts';
import {
  readPack,
  readProject,
  repositoryFacts,
} from '../../src/brain/standards-cli.ts';
import {
  GATES_BUDGET,
  GATES_COMMAND,
  gatesBlock,
  heldOut,
  LANE_BUDGET,
  lanePacket,
  packetBrief,
  QUERY_LIMIT,
  queryStandards,
  workerRecords,
} from '../../src/brain/worker-packet.ts';
import { laneBrief, laneBriefText } from '../../src/cli/lane-brief.ts';
import { contractConventions } from '../../src/repo/contract.ts';

const repo = join(import.meta.dirname, '../..');
const brief =
  'You are working on task t-abc1234. Add to src/cli/slug.ts a function slugify, with a node:test file under test/. Commit your work when it is done.';

test('the lane brief starts with the packet and keeps the lead brief intact', () => {
  const packet = lanePacket(repo, brief, '2026-11-08', 'lane');
  assert.ok(packet !== null && packet.records.length > 0);
  // The lane packet stays within the 600-token lane budget.
  assert.equal(packet.budget, LANE_BUDGET);
  assert.ok(packet.tokens <= packet.budget, `${packet.tokens} tokens`);
  assert.ok(
    packet.records.every((id) => id.startsWith('r-')),
    packet.records.join(),
  );
  const text = packetBrief(packet, brief, true);
  assert.ok(
    text.startsWith(
      `Repository conventions (brain packet ${packet.sha256.slice(0, 12)}; ${SERVE_POLICY}):\n`,
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
  assert.equal(file, '.agents/records.json');
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
  const packet = lanePacket(root, 'format the parser', '2026-11-13', 'unit-b');
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
    /audience: Invalid option/u,
  );
});

const standardRow = (id: string, text: string, extra: object) => ({
  id,
  type: 'standard',
  area: 'tests',
  layer: 'universal',
  audience: 'worker',
  tier: 'reflex',
  text,
  why: 'Because.',
  enforcement: { kind: 'advisory' },
  applies: { stacks: [], needs: [], paths: [], terms: [] },
  provenance: { origin: 'test', evidence: ['AGENTS.md'], proposals: [] },
  status: 'accepted',
  recorded_at: '2026-01-01',
  valid_from: '2026-01-01',
  valid_to: null,
  supersedes: [],
  ...extra,
});

test('one packet carries conventions and project standards, omits command-enforced ones and ranks by match times tier', (t) => {
  const root = conventionsRepo(t, [
    row('r-conv', 'Format the parser with biome.', null),
  ]);
  mkdirSync(join(root, '.agents'));
  writeFileSync(
    join(root, '.agents/standards.json'),
    JSON.stringify([
      standardRow('s-floor', 'Format the parser output.', { tier: 'floor' }),
      standardRow('s-finish', 'Format the parser output.', { tier: 'finish' }),
      standardRow('s-cmd', 'Format the parser with a command.', {
        enforcement: { kind: 'command', run: 'true' },
      }),
      standardRow('s-adopt', 'Format the parser at adoption.', {
        audience: 'adopt',
      }),
    ]),
  );
  const packet = lanePacket(root, 'format the parser', '2026-11-13', 'u');
  assert.equal(packet?.budget, LANE_BUDGET);
  assert.deepEqual(packet?.records, ['s-floor', 'r-conv', 's-finish']);
});

test('the lane packet never exceeds its budget', (t) => {
  const rows = Array.from({ length: 60 }, (_, i) =>
    row(
      `r-${i}`,
      `Format the parser with biome rule number ${i} ${'x'.repeat(60)}.`,
      null,
    ),
  );
  const root = conventionsRepo(t, rows);
  const packet = lanePacket(root, 'format the parser', '2026-11-13', 'u');
  assert.ok((packet?.tokens ?? 0) <= LANE_BUDGET);
  assert.ok((packet?.records.length ?? 0) === SERVE_CAP);
});

test('a record in the task holdout is not served and the same task withholds it again', (t) => {
  const root = conventionsRepo(t, [
    row('r-new', 'Format the parser with biome.', null),
  ]);
  const task = Array.from({ length: 200 }, (_, i) => `unit-${i}`).find((id) =>
    heldOut(id, 'r-new'),
  );
  assert.ok(task !== undefined);
  for (let i = 0; i < 2; i++) {
    const packet = lanePacket(root, 'format the parser', '2026-11-13', task);
    assert.deepEqual(packet?.records, []);
  }
  const served = lanePacket(
    root,
    'format the parser',
    '2026-11-13',
    task,
    undefined,
    false,
  );
  assert.deepEqual(served?.records, ['r-new']);
});

test('withheld is the would-serve set intersected with the holdout, not every held-out candidate', (t) => {
  const root = conventionsRepo(t, [
    row('r-match', 'Format the parser with biome.', null),
    row('r-other', 'Tune the database connection pool.', null),
  ]);
  // A task that holds out both records: only the one the brief matches would have been served.
  const task = Array.from({ length: 2000 }, (_, i) => `unit-${i}`).find(
    (id) => heldOut(id, 'r-match') && heldOut(id, 'r-other'),
  );
  assert.ok(task !== undefined);
  const brief = laneBrief(
    root,
    'format the parser',
    '2026-11-13',
    task,
    false,
    120,
  );
  assert.deepEqual(brief.served, []);
  assert.deepEqual(brief.withheld, ['r-match']);
});

test('the gates block names the stack-applicable enforced floor and finish records and the one check command within 150 tokens', () => {
  const block = gatesBlock(repo, '2026-11-15');
  assert.ok(block !== undefined);
  assert.ok(block.includes(`'${GATES_COMMAND}'`), block);
  assert.ok(tokens(block) <= GATES_BUDGET, `${tokens(block)} tokens`);
  const ids = block.slice(block.indexOf('): ') + 3).split(', ');
  const facts = repositoryFacts(repo);
  const applicable = new Map(
    [
      ...readPack().filter((s) => appliesTo(s, facts)),
      ...readProject(repo),
    ].map((s) => [s.id, s]),
  );
  assert.ok(ids.length > 0);
  for (const id of ids) {
    const standard = applicable.get(id);
    assert.ok(standard, `${id} applies`);
    assert.notEqual(standard.enforcement.kind, 'advisory');
    assert.ok(['floor', 'finish'].includes(standard.tier), id);
  }
  const tiers = ids.map((id) => applicable.get(id)?.tier);
  const firstFinish = tiers.indexOf('finish');
  assert.ok(firstFinish === -1 || !tiers.slice(firstFinish).includes('floor'));
});

test('the lane brief carries the gates block, and the frozen carrier does not', () => {
  const gates = gatesBlock(repo, '2026-11-15');
  assert.ok(gates !== undefined);
  assert.ok(laneBriefText(repo, brief, '2026-11-15').includes(gates));
  assert.ok(
    !laneBriefText(
      repo,
      brief,
      '2026-11-15',
      'lane',
      false,
      undefined,
      false,
    ).includes('Gates run at Stop'),
  );
});

test('the gates block orders the standards review before Stop', () => {
  const block = gatesBlock(repo, '2026-11-15');
  assert.ok(block !== undefined);
  assert.ok(block.startsWith("Before Stop, run 'krn standards review'"), block);
});

test('a captured worker brief writes one exposure row with its task, served and withheld ids, and effect counts it', (t) => {
  // Plain hand-written conventions, a git repository so the log lands in its main checkout.
  const root = conventionsRepo(t, []);
  const git = (...args: string[]) =>
    assert.equal(
      spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }).status,
      0,
    );
  git('init', '-q', '-b', 'main');
  const ids = Array.from({ length: 40 }, (_, i) => `r-fmt-${i}`);
  writeFileSync(
    join(root, '.krn/conventions.json'),
    JSON.stringify(
      ids.map((id) => row(id, `Format the parser with biome ${id}.`, null)),
    ),
  );
  const task = 't-abc1234';
  const held = ids.filter((id) => heldOut(task, id));
  assert.ok(held.length > 0, 'the task holds some record out');
  const run = spawnSync(
    join(repo, 'bin/krn'),
    ['lane', 'brief', '--task', task, '--root', root],
    { input: 'Format the parser with biome.', encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  const rows = readExposures(root).filter((r) => r.task === task);
  assert.equal(rows.length, 1);
  const [exposure] = rows;
  assert.ok(exposure !== undefined && exposure.served.length > 0);
  assert.ok(exposure.withheld.length > 0);
  assert.ok(exposure.withheld.every((id) => heldOut(task, id)));
  assert.ok(exposure.served.every((id) => !heldOut(task, id)));
  const totals = effectTotals(rows);
  for (const id of exposure.served) assert.equal(totals.get(id)?.served, 1);
  for (const id of exposure.withheld) assert.equal(totals.get(id)?.withheld, 1);
});

test('a task-keyed standards query records an exposure row with the records its holdout withheld', (t) => {
  const root = conventionsRepo(t, []);
  assert.equal(
    spawnSync('git', ['-C', root, 'init', '-q', '-b', 'main']).status,
    0,
  );
  const task = 't-abc1234';
  // Five records fit the query limit: one the task holds out, four it serves.
  const pool = Array.from({ length: 60 }, (_, i) => `r-qry-${i}`);
  const ids = [
    ...pool.filter((id) => heldOut(task, id)).slice(0, 1),
    ...pool.filter((id) => !heldOut(task, id)).slice(0, 4),
  ];
  writeFileSync(
    join(root, '.krn/conventions.json'),
    JSON.stringify(
      ids.map((id) => row(id, `Format the parser with biome ${id}.`, null)),
    ),
  );
  const run = spawnSync(
    join(repo, 'bin/krn'),
    [
      'standards',
      'query',
      '--task',
      task,
      '--root',
      root,
      'format the parser with biome',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  const rows = readExposures(root).filter((r) => r.channel === 'query');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.task, task);
  assert.ok((rows[0]?.served.length ?? 0) > 0);
  assert.ok((rows[0]?.withheld.length ?? 0) > 0);
  assert.ok(rows[0]?.withheld.every((id) => heldOut(task, id)));
});

test('a packet over 10 matching records serves exactly 3 and prints the cap and the threshold', (t) => {
  const rows = Array.from({ length: 10 }, (_, i) =>
    row(`r-${i}`, `Format the parser with biome rule ${i}.`, null),
  );
  const root = conventionsRepo(t, rows);
  const packet = lanePacket(root, 'format the parser', '2026-11-13', 'u');
  assert.equal(packet?.records.length, SERVE_CAP);
  assert.equal(SERVE_CAP, 3);
  const text = packetBrief(packet, 'brief', true);
  assert.ok(text.includes(SERVE_POLICY), text);
  assert.ok(text.includes(`>= ${CONFIDENCE_THRESHOLD}`), text);
});

test('an automatic packet with only low-confidence matches serves none while an explicit one-word query still ranks records', (t) => {
  const rows = Array.from({ length: 10 }, (_, i) =>
    row(`r-${i}`, `Format the parser with biome rule ${i}.`, null),
  );
  const root = conventionsRepo(t, rows);
  // One shared word ("parser") is a match, but under the confidence threshold.
  const packet = lanePacket(root, 'parser', '2026-11-13', 'u');
  assert.deepEqual(packet?.records, []);
  assert.equal(packetBrief(packet, 'brief'), 'brief');
  // An explicit query is the agent asking: one word still returns ranked records, capped by the budget.
  const asked = queryStandards(root, {
    text: 'parser',
    files: [],
    asOf: '2026-11-13',
  });
  assert.ok(asked.length > 0);
  assert.ok(asked.length <= QUERY_LIMIT);
});

test('the gates block names at most the cap and prints the policy', () => {
  const block = gatesBlock(repo, '2026-11-15');
  assert.ok(block?.includes(SERVE_POLICY), block);
  const ids = (block ?? '').slice((block ?? '').indexOf('): ') + 3).split(', ');
  assert.ok(ids.length <= SERVE_CAP, block);
});
