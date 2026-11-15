import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  auditFailProposals,
  failureArgs,
  fixCommitProposals,
  promoteCandidates,
  proposeArgs,
  refusedRecords,
} from '../../scripts/lib/outside-harvest.ts';
import { exposureOf, violatedExposure } from '../../src/brain/exposures.ts';
import { harvestCandidates, type Sourced } from '../../src/brain/proposals.ts';
import { parseUnified } from '../../src/brain/record.ts';

const pack = parseUnified([
  {
    id: 's-a',
    type: 'standard',
    text: 'Keep tests next to code.',
    recorded_at: '2026-11-01',
    valid_from: '2026-11-01',
    valid_to: null,
    source: 'krn pack',
    enforcement: { kind: 'command', run: 'true' },
  },
  {
    id: 's-b',
    type: 'standard',
    text: 'Advisory only.',
    recorded_at: '2026-11-01',
    valid_from: '2026-11-01',
    valid_to: null,
    source: 'krn pack',
  },
]);

const sourced = (origin: string, text: string): Sourced => ({
  origin,
  repository: `/r/${origin}`,
  file: 'p.json',
  proposal: {
    text,
    kind: 'check',
    evidence: [`outside:${origin}`],
    recorded_at: '2026-11-15',
  },
});

test('a refused Stop yields one proposal per known record, once', () => {
  const exposures = [
    violatedExposure('x', ['s-a', 's-zz']),
    violatedExposure('y', ['s-a']),
  ];
  const refused = refusedRecords(exposures);
  assert.deepEqual(refused, ['s-a', 's-zz']);
  const args = proposeArgs(refused, pack, 'php');
  assert.equal(args.length, 1);
  assert.deepEqual(args[0]?.slice(0, 4), [
    'standards',
    'propose',
    '--text',
    'Keep tests next to code.',
  ]);
  assert.ok(args[0]?.includes('outside:php:stop:s-a'));
});

test('served-only exposures are no refusal', () => {
  assert.deepEqual(
    refusedRecords([
      exposureOf({
        run: 'r',
        task: undefined,
        channel: 'session',
        served: ['s-a'],
        withheld: [],
        laneOk: true,
        violated: { 's-a': false },
      }),
    ]),
    [],
  );
});

test('a candidate seen in two repositories marks its enforced record harvested; one repository does not', () => {
  const two = harvestCandidates([
    sourced('php', 'Keep tests next to code'),
    sourced('npm', 'Keep tests next to code.'),
    sourced('py', 'Advisory only.'),
    sourced('php', 'Advisory only.'),
  ]);
  const result = promoteCandidates(pack, two);
  assert.deepEqual(result.promoted, ['s-a']);
  assert.deepEqual(result.pack[0]?.harvested, {
    origins: ['php', 'npm'],
    occurrences: 2,
  });
  assert.equal(result.pack[1]?.harvested, undefined);
  const once = promoteCandidates(
    pack,
    harvestCandidates([sourced('php', 'Keep tests next to code.')]),
  );
  assert.deepEqual(once.promoted, []);
  assert.deepEqual(promoteCandidates(result.pack, two).promoted, []);
});

const auditMarkdown = [
  '# Audit',
  '',
  '| record | php | npm | py |',
  '| --- | --- | --- | --- |',
  '| s-a | FAIL | FAIL | pass |',
  '| s-b | FAIL | pass | pass |',
  '',
  '| record | php | npm | py |',
  '| --- | --- | --- | --- |',
  '| s-a | pass | pass | pass |',
].join('\n');

test('an audit FAIL seen in two repositories becomes proposals that promote its enforced record; a single FAIL does not', () => {
  const sources = auditFailProposals(auditMarkdown, pack, '2026-11-15');
  assert.deepEqual(
    sources.map((s) => `${s.origin}:${s.proposal.text}`),
    ['php:Keep tests next to code.', 'npm:Keep tests next to code.'],
  );
  const result = promoteCandidates(pack, harvestCandidates(sources));
  assert.deepEqual(result.promoted, ['s-a']);
});

test('merged fix commits become proposals with their PR number; other subjects are skipped', () => {
  const sources = fixCommitProposals(
    [
      'fix(ship): a base merges directly (t-x) (#900)',
      'feat(outside): rows (#939)',
      'fix: plain (#12)',
      'fix(ship): no number',
    ],
    'krn',
    '2026-11-15',
  );
  assert.deepEqual(
    sources.map((s) => s.proposal.evidence),
    [['#900'], ['#12']],
  );
});

test('a failed hidden test and a non-zero drain each propose one lesson', () => {
  assert.equal(failureArgs('php', 'pass', 0).length, 0);
  assert.equal(failureArgs('php', 'none', undefined).length, 0);
  const both = failureArgs('php', 'fail', 3);
  assert.equal(both.length, 2);
  assert.ok(both[0]?.includes('outside:php:hidden'));
  assert.ok(both[1]?.includes('outside:php:drain:3'));
});

test('the shipped pack marks the records the audit saw fail in every public row as harvested', () => {
  const real = parseUnified(
    JSON.parse(readFileSync('standards/records.json', 'utf8')),
  );
  for (const id of [
    's-ci-runs-tests',
    's-linter-configured',
    's-readme-test-command',
  ]) {
    const record = real.find((entry) => entry.id === id);
    assert.ok(record?.enforcement.kind !== 'advisory');
    assert.ok((record?.harvested?.origins.length ?? 0) >= 2, id);
  }
});
