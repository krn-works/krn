import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  appendExposure,
  EXPOSURES_FILE,
  effectRows,
  effectTotals,
  exposureOf,
  readExposures,
  violatedExposure,
} from '../../src/brain/exposures.ts';
import { recordChecks } from '../../src/brain/standards-cli.ts';

const input = {
  run: 'lane-a',
  task: 't-1',
  channel: 'lane',
  served: ['r-a', 'r-b'],
  withheld: ['r-c'],
  at: '2026-11-15T10:00:00.000Z',
};

test('an exposure row is krn.exposure/v1: at, attempt, tokens and a per-record violated, with no rework', () => {
  const main = mkdtempSync(join(tmpdir(), 'krn-exposures-'));
  try {
    appendExposure(
      main,
      exposureOf({
        ...input,
        laneOk: true,
        attempt: 2,
        tokens: 123,
        violated: { 'r-a': false, 'r-c': true },
      }),
    );
    const lines = readFileSync(join(main, EXPOSURES_FILE), 'utf8')
      .trim()
      .split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0] ?? ''), {
      schema: 'krn.exposure/v1',
      at: '2026-11-15T10:00:00.000Z',
      run: 'lane-a',
      task: 't-1',
      channel: 'lane',
      attempt: 2,
      served: ['r-a', 'r-b'],
      withheld: ['r-c'],
      tokens: 123,
      violated: { 'r-a': false, 'r-b': null, 'r-c': true },
      outcome: { 'r-a': 'followed' },
      lane_ok: true,
    });
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

test('a failed run does not mark its served records violated: only a record check does', () => {
  const row = exposureOf({ ...input, laneOk: false });
  assert.deepEqual(row.violated, { 'r-a': null, 'r-b': null, 'r-c': null });
  assert.deepEqual(row.outcome, {});
  const refused = violatedExposure('sess', ['s-x']);
  assert.deepEqual(refused.violated, { 's-x': true });
  assert.deepEqual(refused.outcome, { 's-x': 'violated' });
});

test('a run that served and withheld nothing leaves no line', () => {
  const main = mkdtempSync(join(tmpdir(), 'krn-exposures-'));
  try {
    appendExposure(
      main,
      exposureOf({ ...input, served: [], withheld: [], laneOk: true }),
    );
    assert.deepEqual(readExposures(main), []);
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

test('a row written before the schema (rework, run-wide outcome) reads with null violations except a refused Stop', () => {
  const main = mkdtempSync(join(tmpdir(), 'krn-exposures-'));
  try {
    const path = join(main, EXPOSURES_FILE);
    mkdirSync(dirname(path), { recursive: true });
    const old = (channel: string) =>
      JSON.stringify({
        run: 'old',
        task: null,
        channel,
        served: ['r-a'],
        withheld: [],
        outcome: { 'r-a': 'violated' },
        lane_ok: false,
        rework: 1,
      });
    writeFileSync(path, `${old('lane')}\n${old('stop')}\n`);
    const [lane, stop] = readExposures(main);
    assert.deepEqual(lane?.violated, { 'r-a': null });
    assert.deepEqual(stop?.violated, { 'r-a': true });
    assert.ok(!('rework' in (lane ?? {})));
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

test('effect counts a task once per record and arm (latest attempt) and rates the record check per arm', () => {
  const rows = [
    exposureOf({ ...input, laneOk: true, violated: { 'r-a': true } }),
    // Same task rerun: replaces the first attempt of r-a.
    exposureOf({
      ...input,
      attempt: 2,
      laneOk: true,
      violated: { 'r-a': false, 'r-b': true },
    }),
    exposureOf({
      ...input,
      run: 'lane-b',
      task: 't-2',
      served: ['r-c'],
      withheld: ['r-a'],
      laneOk: true,
      violated: { 'r-c': false, 'r-a': true },
    }),
  ];
  assert.deepEqual(effectTotals(rows).get('r-a'), {
    served: 1,
    servedScoped: 1,
    servedViolated: 0,
    withheld: 1,
    withheldScoped: 1,
    withheldViolated: 1,
  });
  assert.deepEqual(effectRows(rows), [
    'r-a: served 1 (scoped 1, violated 0%) withheld 1 (scoped 1, violated 100%)',
    'r-b: served 1 (scoped 1, violated 100%) withheld 0 (scoped 0, violated -)',
    'r-c: served 1 (scoped 1, violated 0%) withheld 1 (scoped 0, violated -)',
  ]);
});

const probe = (id: string, run: string, kind = 'command') => ({
  id,
  type: 'standard',
  area: 'tests',
  layer: 'universal',
  audience: 'worker',
  tier: 'floor',
  text: 'A probe rule.',
  why: 'Probe.',
  provenance: { origin: 'test', evidence: ['README.md'], proposals: [] },
  enforcement: kind === 'advisory' ? { kind } : { kind, run },
  applies: { stacks: [], needs: [], paths: [], terms: [] },
  status: 'accepted',
  supersedes: [],
  recorded_at: '2026-01-01',
  valid_from: '2026-01-01',
  valid_to: null,
});

test('a lane exposure on a clean diff records false for a passing served record, true for a failing one, null for advisory or unknown', () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-record-checks-'));
  try {
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(
      join(root, '.agents/standards.json'),
      JSON.stringify([
        probe('s-clean', 'true'),
        probe('s-dirty', 'false'),
        probe('s-held', 'true'),
        probe('s-note', '', 'advisory'),
      ]),
    );
    const violated = recordChecks(root, [
      'r-r-1',
      's-clean',
      's-dirty',
      's-held',
      's-note',
    ]);
    const row = exposureOf({
      run: 't-04ewf93',
      task: 't-04ewf93',
      channel: 'lane',
      served: ['s-clean', 's-dirty', 's-note'],
      withheld: ['s-held', 'r-r-1'],
      laneOk: true,
      violated,
    });
    assert.deepEqual(row.violated, {
      's-clean': false,
      's-dirty': true,
      's-note': null,
      's-held': false,
      'r-r-1': null,
    });
    assert.deepEqual(row.outcome, {
      's-clean': 'followed',
      's-dirty': 'violated',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
