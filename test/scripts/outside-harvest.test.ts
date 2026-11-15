import assert from 'node:assert/strict';
import test from 'node:test';
import {
  promoteCandidates,
  proposeArgs,
  refusedRecords,
} from '../../scripts/lib/outside-harvest.ts';
import { violatedExposure } from '../../src/brain/exposures.ts';
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
      {
        run: 'r',
        task: null,
        channel: 'session',
        served: ['s-a'],
        withheld: [],
        outcome: { 's-a': 'followed' },
        lane_ok: true,
        rework: 0,
      },
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
