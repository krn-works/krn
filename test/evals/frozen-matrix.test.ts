import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  analyze,
  matrixProblems,
  type Prereg,
  parsePrereg,
  reportLines,
} from '../../evals/replay/abc.ts';
import type { ArmId } from '../../evals/replay/arms.ts';
import type { Row } from '../../evals/replay/rows.ts';
import { inputOnly } from './token-fixture.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));

const frozen: Prereg = {
  units: ['t-aa', 't-bb'],
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

/** The whole matrix: 2 units x 3 arms x 2 reps = 12 rows, one harness, one model. */
const complete = (): Row[] =>
  frozen.units.flatMap((unit) =>
    (['A', 'B', 'C'] as ArmId[]).flatMap((arm) =>
      [1, 2].map((rep) => ({
        unit,
        arm,
        rep,
        pass: arm === 'C' ? rep === 1 : rep === 2,
        cost: 0.5,
        tokens: inputOnly(0.5),
        harness: 'a1',
        model: 'sonnet',
      })),
    ),
  );

/** 12 rows that look like a matrix: rep 99 in place of rep 2 and a second harness. */
const mixed = (): Row[] =>
  complete().map((r, i) => ({
    ...r,
    rep: r.rep === 2 ? 99 : r.rep,
    harness: i === 0 ? 'b2' : r.harness,
  }));

const prereg = [
  '## Design',
  'reps: 2',
  'contrasts: C-A, C-B',
  'alpha: 0.05',
  'model: sonnet',
  'harness-sha: a1',
  'mde-pp: 15',
  'cost-prices: input 2, output 10, cache-read 0.1, cache-write-5m 2.5, cache-write-1h 4',
  'cost-sensitivity: input 2, output 10, cache-read 2, cache-write-5m 2, cache-write-1h 2',
  '## Units',
  '- t-aa',
  '- t-bb',
  '',
].join('\n');

const strictReport = (rows: Row[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'frozen-matrix-'));
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
      '--strict',
      '--rows',
      join(dir, 'rows.jsonl'),
    ],
    { encoding: 'utf8' },
  );
};

test('the fixture prereg parses to the frozen matrix', () => {
  const p = parsePrereg(prereg);
  assert.deepEqual(p.units, frozen.units);
  assert.equal(p.reps, 2);
});

test('a complete one-harness matrix with no shown contrast is accepted', () => {
  const rows = complete();
  assert.equal(rows.length, 12);
  assert.deepEqual(matrixProblems(rows, frozen), []);
  const result = strictReport(rows);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /not shown/);
});

test('a 12-row rep-99 mixed-harness matrix is refused before any test', () => {
  const rows = mixed();
  assert.equal(rows.length, 12);
  const problems = matrixProblems(rows, frozen).join('\n');
  assert.match(problems, /rep 99 outside 1\.\.2/);
  assert.match(problems, /missing t-aa A rep 2/);
  assert.match(problems, /mixed harness: a1, b2/);
  const result = strictReport(rows);
  assert.equal(result.status, 65);
  assert.match(result.stderr, /verdict: matrix incomplete or mixed/);
  assert.doesNotMatch(result.stdout, /shown/);
});

test('a duplicate, ungraded or mixed-model cell is a problem', () => {
  const dup = [...complete(), complete()[0] as Row];
  assert.match(
    matrixProblems(dup, frozen).join('\n'),
    /duplicate t-aa A rep 1/,
  );
  const ungraded = complete().map((r, i) =>
    i === 0 ? { ...r, pass: null } : r,
  );
  assert.match(
    matrixProblems(ungraded, frozen).join('\n'),
    /ungraded t-aa A rep 1/,
  );
  const models = complete().map((r, i) =>
    i === 0 ? { ...r, model: 'opus' } : r,
  );
  assert.match(
    matrixProblems(models, frozen).join('\n'),
    /mixed realized model/,
  );
  const unknown = complete().map((r, i) => {
    const { model: _m, ...rest } = r;
    return i === 0 ? rest : r;
  });
  assert.match(matrixProblems(unknown, frozen).join('\n'), /sonnet, unknown/);
});

test('an unknown cost stays null, is reported and never counts as zero dollars', () => {
  const rows = complete().map((r, i) => (i === 0 ? { ...r, tokens: null } : r));
  const report = analyze(rows, frozen);
  assert.deepEqual(report.unknownCost, { A: 1, B: 0, C: 0 });
  assert.match(reportLines(report, frozen).join('\n'), /unknown cost A 1/);
  assert.equal(analyze(complete(), frozen).unknownCost.A, 0);
});

test('ungraded spend stays in dollars per resolution', () => {
  const rows = complete().map((r) =>
    r.arm === 'C' && r.rep === 2 ? { ...r, pass: null } : r,
  );
  // C: 2 passes (rep 1 of two units), 4 sessions at 0.5 each = 2.0 / 2
  assert.equal(analyze(rows, frozen).usdPerResolved.C, 1);
});
