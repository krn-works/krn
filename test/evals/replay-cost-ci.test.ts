import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyze, type Prereg, reportLines } from '../../evals/replay/abc.ts';
import type { ArmId } from '../../evals/replay/arms.ts';
import type { Row } from '../../evals/replay/rows.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));

const frozen: Prereg = {
  units: ['t-aa', 't-bb', 't-cc'],
  reps: 2,
  alpha: 0.05,
  mdePp: 15,
  models: ['sonnet'],
  harness: 'a1',
  contrasts: [
    ['C', 'A'],
    ['C', 'B'],
  ],
};

const unitCost: Record<string, number> = { 't-aa': 1, 't-bb': 2, 't-cc': 4 };
const armFactor: Record<ArmId, number> = { A: 1, B: 0.9, C: 0.5 };

/** 3 units x 3 arms x 2 reps; cost varies by unit and arm, every row passes except arm A rep 1. */
const complete = (): Row[] =>
  frozen.units.flatMap((unit) =>
    (['A', 'B', 'C'] as ArmId[]).flatMap((arm) =>
      [1, 2].map((rep) => ({
        unit,
        arm,
        rep,
        pass: !(arm === 'A' && rep === 1),
        cost: (unitCost[unit] as number) * armFactor[arm] * (1 + rep / 10),
        harness: 'a1',
        model: 'sonnet',
      })),
    ),
  );

const prereg = [
  'reps: 2',
  'contrasts: C-A, C-B',
  'alpha: 0.05',
  'model: sonnet',
  'harness-sha: a1',
  'mde-pp: 15',
  '## Units',
  '- t-aa',
  '- t-bb',
  '- t-cc',
  '',
].join('\n');

const report = (rows: Row[], strict: boolean) => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-cost-ci-'));
  writeFileSync(join(dir, 'prereg.md'), prereg);
  writeFileSync(
    join(dir, 'rows.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n'),
  );
  return spawnSync(
    process.execPath,
    [
      join(repo, 'evals/replay/run.ts'),
      '--prereg',
      join(dir, 'prereg.md'),
      '--report',
      ...(strict ? ['--strict'] : []),
      '--rows',
      join(dir, 'rows.jsonl'),
    ],
    { encoding: 'utf8' },
  );
};

test('full rows print the cost log-ratio CI, Holm p, unit count and USD per resolved with a CI', () => {
  const result = report(complete(), true);
  assert.equal(result.status, 0, result.stderr);
  const cost = result.stdout
    .split('\n')
    .filter((l) => l.startsWith('verdict: cost'));
  assert.equal(cost.length, 2);
  for (const l of cost) {
    assert.match(l, /95% CI \[-?\d+\.\d+, -?\d+\.\d+\]/);
    assert.match(l, /Holm p \d/);
    assert.match(l, /n 3 units/);
  }
  // The ratio is exactly 0.5 for C over A in every unit, so its CI collapses onto it.
  assert.match(cost[0] as string, /ratio 0\.50 /);
  for (const arm of ['A', 'B', 'C'])
    assert.match(
      result.stdout,
      new RegExp(`cost: USD per resolved ${arm} \\d+\\.\\d+ 95% CI \\[`),
    );
});

test('the USD per resolved bootstrap is deterministic', () => {
  const a = reportLines(analyze(complete(), frozen), frozen);
  const b = reportLines(analyze(complete(), frozen), frozen);
  assert.deepEqual(a, b);
});

test('a row without total_cost_usd fails --report --strict naming the row', () => {
  const rows = complete().map((r) =>
    r.unit === 't-bb' && r.arm === 'C' && r.rep === 2
      ? { ...r, cost: null }
      : r,
  );
  const result = report(rows, true);
  assert.equal(result.status, 65);
  assert.match(result.stderr, /no total_cost_usd for t-bb C rep 2/);
  assert.doesNotMatch(result.stdout, /verdict: cost/);
});

test('without --strict a missing cost shrinks the pair and the unit count says so', () => {
  const rows = complete().map((r) =>
    r.unit === 't-bb' && r.arm === 'C' ? { ...r, cost: null } : r,
  );
  const result = report(rows, false);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verdict: cost C-A .*n 2 units/);
});
