import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  armSecondary,
  discordantUnits,
  type Observation,
  pairedDifference,
  report,
  unitMeans,
} from '../../evals/d23/analysis.ts';
import { observation, runFacts } from '../../evals/d23/runs.ts';

const o = (
  unit: string,
  arm: string,
  run: number,
  correct: boolean,
  extra: Partial<Observation> = {},
): Observation => ({
  unit,
  arm,
  run,
  correct,
  scopeClean: true,
  refusal: false,
  costUsd: 1,
  ...extra,
});

const fixture: Observation[] = [
  // unit a: K 3/3, P 1/3; unit b: K 2/3, P 2/3; unit c: K 3/3, P 0/3
  ...[1, 2, 3].map((r) => o('a', 'K', r, true)),
  ...[1, 2, 3].map((r) => o('a', 'P', r, r === 1)),
  ...[1, 2, 3].map((r) => o('b', 'K', r, r < 3)),
  ...[1, 2, 3].map((r) => o('b', 'P', r, r < 3)),
  ...[1, 2, 3].map((r) => o('c', 'K', r, true)),
  ...[1, 2, 3].map((r) => o('c', 'P', r, false, { refusal: r === 1 })),
];

test('per-unit means average the repeats of one unit', () => {
  const m = unitMeans(fixture, 'P');
  assert.equal(m.get('a'), 1 / 3);
  assert.equal(m.get('b'), 2 / 3);
  assert.equal(m.get('c'), 0);
});

test('the paired difference clusters on the unit: SE comes from the per-unit differences', () => {
  const r = pairedDifference(fixture, 'K', 'P');
  assert.equal(r.units, 3);
  // differences 2/3, 0, 1 -> mean 5/9, sample variance 0.2346..., se = sqrt(var/3)
  assert.ok(Math.abs(r.diff - 5 / 9) < 1e-12);
  const d = [2 / 3, 0, 1];
  const v = d.reduce((s, x) => s + (x - 5 / 9) ** 2, 0) / 2;
  assert.ok(Math.abs(r.se - Math.sqrt(v / 3)) < 1e-12);
  assert.ok(r.ciLow < r.diff && r.diff < r.ciHigh);
  assert.ok(r.p > 0 && r.p < 1);
});

test('identical arms give a zero difference and p of 1', () => {
  const same = [o('a', 'K', 1, true), o('a', 'P', 1, true)];
  const r = pairedDifference(same, 'K', 'P');
  assert.equal(r.diff, 0);
  assert.equal(r.p, 1);
});

test('only units both arms ran are paired', () => {
  const r = pairedDifference([...fixture, o('z', 'K', 1, true)], 'K', 'P');
  assert.equal(r.units, 3);
});

test('secondary measures count scope, refusals and cost per correct run', () => {
  const s = armSecondary(fixture, 'P');
  assert.equal(s.runs, 9);
  assert.equal(s.correct, 3);
  assert.equal(s.refusals, 1);
  assert.equal(s.costPerCorrect, 3);
  assert.equal(armSecondary([o('a', 'P', 1, false)], 'P').costPerCorrect, null);
});

test('the report names every arm and the paired difference against P', () => {
  const text = report(fixture, ['K', 'P']);
  assert.match(text, /\| K \| 3 \|/);
  assert.match(text, /K - P: 55\.6 pp over 3 units/);
});

test('with K and PB the report adds the harness contrast and the units where K loses', () => {
  const obs = [
    o('a', 'K', 1, false),
    o('a', 'PB', 1, true),
    o('a', 'P', 1, false),
    o('b', 'K', 1, true),
    o('b', 'PB', 1, false),
    o('b', 'P', 1, false),
    o('c', 'K', 1, true),
    o('c', 'PB', 1, true),
    o('c', 'P', 1, true),
  ];
  assert.deepEqual(discordantUnits(obs, 'K', 'PB'), {
    below: ['a'],
    above: ['b'],
  });
  const text = report(obs, ['K', 'P', 'PB']);
  assert.match(text, /K - PB: 0\.0 pp over 3 units/);
  assert.match(text, /K below PB: a\nK above PB: b/);
  assert.doesNotMatch(report(obs, ['K', 'P']), /K - PB|K below PB/);
});

test('a refusal is a normal end without a patch; a failed session is not', () => {
  const grade = { ran: false, functional: false, scopeClean: true };
  assert.equal(
    observation('1', 'K', 1, grade, {
      finished: true,
      costUsd: 2,
      endedNormally: true,
    }).refusal,
    true,
  );
  assert.equal(
    observation('1', 'K', 1, grade, {
      finished: true,
      costUsd: 2,
      endedNormally: false,
    }).refusal,
    false,
  );
});

test('run facts read cost and normal end from the session record and need a finished measure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'd23-runs-'));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '1.K.meas'), 'claude_exit=0\nmeasured\n');
    writeFileSync(
      join(dir, '1.K.claude.json'),
      JSON.stringify({
        is_error: false,
        result: 'I stopped.',
        total_cost_usd: 1.5,
      }),
    );
    assert.deepEqual(runFacts(dir, '1.K'), {
      finished: true,
      costUsd: 1.5,
      endedNormally: true,
    });
    assert.equal(runFacts(dir, '2.K').finished, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
