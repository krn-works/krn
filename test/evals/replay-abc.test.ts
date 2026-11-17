import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  analyze,
  holm,
  type Prereg,
  parsePrereg,
  reportLines,
} from '../../evals/replay/abc.ts';
import type { ArmId } from '../../evals/replay/arms.ts';
import type { Row } from '../../evals/replay/rows.ts';
import { eligible, type ScreenUnit } from '../../evals/replay/screen.ts';
import { loadUnits } from '../../evals/units/unit.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const prereg = join(repo, 'evals/replay/abc.prereg.md');

const close = (a: number, b: number) =>
  assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

/** Three reps of one arm on one unit: `passes` of them pass, each costing `cost`. */
const reps = (unit: string, arm: ArmId, passes: number, cost: number): Row[] =>
  [1, 2, 3].map((rep) => ({
    unit,
    arm,
    rep,
    pass: rep <= passes,
    cost,
    harness: 'h',
  }));

const frozen: Prereg = {
  units: ['t-1', 't-2', 't-3', 't-4'],
  reps: 3,
  alpha: 0.05,
  mdePp: 15,
  contrasts: [
    ['C', 'A'],
    ['C', 'B'],
  ],
};

test('Holm adjusts in ascending order, stays monotone and caps at 1', () => {
  // sorted 0.03 -> 2 * 0.03 = 0.06; 0.04 -> max(0.06, 0.04) = 0.06
  const [p1, p2] = holm([0.04, 0.03]);
  close(p1 as number, 0.06);
  close(p2 as number, 0.06);
  const [q1, q2] = holm([0.001, 0.2]);
  close(q1 as number, 0.002);
  close(q2 as number, 0.2);
  assert.deepEqual(holm([0.7, 0.9]), [1, 1]);
});

test('clustered SE and Holm decision match hand-computed values', () => {
  // C passes 3 of 3 everywhere. A passes [0,0,1,1] of 3: unit diffs 1,1,2/3,2/3, mean 5/6,
  // variance (4 / 36) / 3 = 1/27, SE sqrt(1/108) = 0.0962250.
  // B passes [1,1,2,2] of 3: diffs 2/3,2/3,1/3,1/3, mean 1/2, same variance and SE.
  const rows = frozen.units.flatMap((u, i) => [
    ...reps(u, 'C', 3, 1),
    ...reps(u, 'A', [0, 0, 1, 1][i] as number, 1),
    ...reps(u, 'B', [1, 1, 2, 2][i] as number, 1),
  ]);
  const r = analyze(rows, frozen);
  const [ca, cb] = r.contrasts;
  assert.equal(ca?.name, 'C-A');
  close(ca?.estimatePp as number, (5 / 6) * 100);
  close(cb?.estimatePp as number, 50);
  close(ca?.sePp as number, Math.sqrt(1 / 108) * 100);
  close(cb?.sePp as number, Math.sqrt(1 / 108) * 100);
  // z = 8.66 and 5.20; the larger p is adjusted by 1, the smaller by 2, and the sequence stays monotone.
  assert.ok((ca?.rawP as number) < (cb?.rawP as number));
  const smaller = Math.min(1, 2 * (ca?.rawP as number));
  close(ca?.adjustedP as number, smaller);
  close(cb?.adjustedP as number, Math.max(smaller, cb?.rawP as number));
  assert.ok((ca?.adjustedP as number) <= (cb?.adjustedP as number));
  assert.equal(ca?.shown, true);
  assert.equal(cb?.shown, true);
  // equal cost everywhere: log ratio 0
  close(ca?.logCostRatio as number, 0);
  const lines = reportLines(r, frozen);
  assert.equal(lines.filter((l) => l.startsWith('verdict:')).length, 2);
  assert.match(
    lines[0] as string,
    /^verdict: C-A \+83\.3 pp, clustered SE 9\.6 pp \(4 units\), Holm p .*, shown/,
  );
});

test('a contrast whose adjusted p stays above alpha is not shown', () => {
  // C beats A by a noisy margin: diffs 1,-1,1,0 -> mean 1/4, variance 1.0833/... , z well below 2.
  const rows = [
    ...reps('t-1', 'C', 3, 1),
    ...reps('t-1', 'A', 0, 1),
    ...reps('t-2', 'C', 0, 1),
    ...reps('t-2', 'A', 3, 1),
    ...reps('t-3', 'C', 3, 1),
    ...reps('t-3', 'A', 0, 1),
    ...reps('t-4', 'C', 1, 1),
    ...reps('t-4', 'A', 1, 1),
    ...frozen.units.flatMap((u) => reps(u, 'B', 3, 1)),
  ];
  const r = analyze(rows, frozen);
  const ca = r.contrasts[0];
  close(ca?.estimatePp as number, 25);
  assert.equal(ca?.shown, false);
  assert.match(reportLines(r, frozen)[0] as string, /not shown/);
  // C is worse than B everywhere it differs: never shown, whatever the p.
  assert.equal(r.contrasts[1]?.shown, false);
});

test('rows of units outside the frozen list and ungraded rows are ignored', () => {
  const rows: Row[] = [
    ...reps('t-other', 'C', 3, 1),
    { unit: 't-1', arm: 'C', rep: 1, pass: null, cost: 0, harness: 'h' },
  ];
  assert.equal(analyze(rows, frozen).graded, 0);
});

test('the frozen preregistration parses and lists exactly the eligible units', () => {
  const p = parsePrereg(readFileSync(prereg, 'utf8'));
  assert.equal(p.reps, 3);
  assert.equal(p.alpha, 0.05);
  assert.equal(p.mdePp, 15);
  assert.deepEqual(p.contrasts, [
    ['C', 'A'],
    ['C', 'B'],
  ]);
  const ids = eligible(
    loadUnits(join(repo, 'evals/units')).map((u) => u.unit as ScreenUnit),
  )
    .map((u) => u.id)
    .sort();
  assert.deepEqual([...p.units].sort(), ids);
  assert.match(readFileSync(prereg, 'utf8'), /375 USD/);
});

test('--report on an empty rows file exits 65 and on rows prints one verdict per contrast', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abc-'));
  const rowsFile = join(dir, 'rows.jsonl');
  writeFileSync(rowsFile, '');
  const run = () =>
    spawnSync(
      process.execPath,
      [
        'evals/replay/run.ts',
        '--prereg',
        prereg,
        '--report',
        '--rows',
        rowsFile,
      ],
      { cwd: repo, encoding: 'utf8' },
    );
  assert.equal(run().status, 65);
  const units = parsePrereg(readFileSync(prereg, 'utf8')).units;
  writeFileSync(
    rowsFile,
    `${units
      .flatMap((u, i) => [
        ...reps(u, 'A', i % 3, 0.5),
        ...reps(u, 'B', i % 3, 0.5),
        ...reps(u, 'C', 3, 0.6),
      ])
      .map((r) => JSON.stringify(r))
      .join('\n')}\n`,
  );
  const out = run();
  assert.equal(out.status, 0, out.stderr);
  assert.equal(
    out.stdout.split('\n').filter((l) => l.startsWith('verdict:')).length,
    2,
  );
  assert.match(out.stdout, /cost: USD per resolved task/);
});
