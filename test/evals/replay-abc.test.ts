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
  matrixProblems,
  type Prereg,
  parsePrereg,
  reportLines,
} from '../../evals/replay/abc.ts';
import type { ArmId, RowArm } from '../../evals/replay/arms.ts';
import type { Row } from '../../evals/replay/rows.ts';
import { eligible, type ScreenUnit } from '../../evals/replay/screen.ts';
import { loadUnits } from '../../evals/units/unit.ts';
import { inputOnly } from './token-fixture.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const prereg = join(repo, 'evals/replay/abc.prereg.md');

const close = (a: number, b: number) =>
  assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

/** Three reps of one arm on one unit: `passes` of them pass, each costing `cost`. */
const reps = (unit: string, arm: RowArm, passes: number, cost: number): Row[] =>
  [1, 2, 3].map((rep) => ({
    unit,
    arm,
    rep,
    pass: rep <= passes,
    cost,
    tokens: inputOnly(cost),
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
  // Primary claims: cost C-A and C-B, then regression (not measured: no row records it).
  assert.equal(lines.filter((l) => l.startsWith('verdict:')).length, 3);
  assert.match(lines[0] as string, /^verdict: cost C-A ratio 1\.00 /);
  assert.match(lines[2] as string, /^verdict: regression not measured/);
  assert.match(
    lines.find((l) => l.startsWith('secondary: pass rate C-A')) as string,
    /^secondary: pass rate C-A \+83\.3 pp, clustered SE 9\.6 pp \(4 units\), Holm p .*, shown/,
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
  assert.match(
    reportLines(r, frozen).find((l) =>
      l.startsWith('secondary: pass rate C-A'),
    ) as string,
    /not shown/,
  );
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
  assert.equal(p.mdePp, 16);
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
    3,
  );
  assert.match(out.stdout, /cost: USD per resolved task/);
});

test('strict matrix refuses a uniform wrong harness sha or an unpinned or unknown model', () => {
  const pinned: Prereg = {
    ...frozen,
    models: ['sonnet', 'opus'],
    harness: 'abc123',
  };
  const matrix = (extra: Partial<Row>): Row[] =>
    frozen.units.flatMap((u) =>
      (['A', 'B', 'C'] as ArmId[]).flatMap((arm) =>
        reps(u, arm, 2, 1).map((r) => ({
          ...r,
          harness: 'abc123',
          model: 'claude-sonnet-4',
          ...extra,
        })),
      ),
    );
  assert.deepEqual(matrixProblems(matrix({}), pinned), []);
  const sha = matrixProblems(matrix({ harness: 'deadbeef' }), pinned);
  assert.ok(
    sha.some((p) => p.includes('not the preregistered abc123')),
    `${sha}`,
  );
  const other = matrixProblems(matrix({ model: 'gpt-6' }), pinned);
  assert.ok(
    other.some((p) => p.includes('outside the pinned set')),
    `${other}`,
  );
  const unknown = matrixProblems(matrix({ model: null }), pinned);
  assert.ok(
    unknown.some((p) => p.includes('outside the pinned set')),
    `${unknown}`,
  );
  assert.ok(
    matrixProblems(matrix({}), frozen).some((p) =>
      p.includes('no harness-sha'),
    ),
  );
});

test('parsePrereg reads the pinned model families and the frozen harness sha', () => {
  const p = parsePrereg(
    'reps: 1\nalpha: 0.05\nmde-pp: 15\ncontrasts: C-A\nmodel: sonnet (fallback opus, as x sets it)\nharness-sha: 0123abcd\ncost-prices: input 2, output 10, cache-read 0.1, cache-write-5m 2.5, cache-write-1h 4\ncost-sensitivity: input 2, output 10, cache-read 2, cache-write-5m 2, cache-write-1h 2\n- t-1\n',
  );
  assert.deepEqual(p.models, ['sonnet', 'opus']);
  assert.equal(p.harness, '0123abcd');
});

/** Verbatim rows as the matrix runner writes them (one JSON object per line), with the regression flag the grader sets. */
const verbatim = [
  '{"unit":"t-1","arm":"A","rep":1,"pass":true,"cost":0.8,"tokens":{"input":400000,"output":0,"cacheRead":0,"cacheWrite5m":0,"cacheWrite1h":0},"harness":"h","model":"claude-sonnet-4","verdict":"pass","regressed":false}',
  '{"unit":"t-1","arm":"B","rep":1,"pass":true,"cost":0.7,"tokens":{"input":350000,"output":0,"cacheRead":0,"cacheWrite5m":0,"cacheWrite1h":0},"harness":"h","model":"claude-sonnet-4","verdict":"pass","injection":900,"regressed":false}',
  '{"unit":"t-1","arm":"C","rep":1,"pass":true,"cost":0.4,"tokens":{"input":200000,"output":0,"cacheRead":0,"cacheWrite5m":0,"cacheWrite1h":0},"harness":"h","model":"claude-sonnet-4","verdict":"pass","injection":900,"regressed":false}',
  '{"unit":"t-2","arm":"A","rep":1,"pass":true,"cost":0.9,"tokens":{"input":450000,"output":0,"cacheRead":0,"cacheWrite5m":0,"cacheWrite1h":0},"harness":"h","model":"claude-sonnet-4","verdict":"pass","regressed":true}',
  '{"unit":"t-2","arm":"B","rep":1,"pass":false,"cost":0.9,"tokens":{"input":450000,"output":0,"cacheRead":0,"cacheWrite5m":0,"cacheWrite1h":0},"harness":"h","model":"claude-sonnet-4","verdict":"fail","regressed":false}',
  '{"unit":"t-2","arm":"C","rep":1,"pass":true,"cost":0.5,"tokens":{"input":250000,"output":0,"cacheRead":0,"cacheWrite5m":0,"cacheWrite1h":0},"harness":"h","model":"claude-sonnet-4","verdict":"pass","injection":900,"regressed":false}',
  '{"unit":"t-3","arm":"A","rep":1,"pass":false,"cost":0.6,"tokens":{"input":300000,"output":0,"cacheRead":0,"cacheWrite5m":0,"cacheWrite1h":0},"harness":"h","model":"claude-sonnet-4","verdict":"fail","regressed":false}',
  '{"unit":"t-3","arm":"B","rep":1,"pass":true,"cost":0.6,"tokens":{"input":300000,"output":0,"cacheRead":0,"cacheWrite5m":0,"cacheWrite1h":0},"harness":"h","model":"claude-sonnet-4","verdict":"pass","regressed":false}',
  '{"unit":"t-3","arm":"C","rep":1,"pass":true,"cost":0.3,"tokens":{"input":150000,"output":0,"cacheRead":0,"cacheWrite5m":0,"cacheWrite1h":0},"harness":"h","model":"claude-sonnet-4","verdict":"pass","injection":900,"regressed":false}',
].map((l) => JSON.parse(l) as Row);

const threeUnits: Prereg = { ...frozen, units: ['t-1', 't-2', 't-3'], reps: 1 };

test('one verdict line per primary claim: cost C-A and C-B under Holm, regression C-A, then the secondary pass rates', () => {
  const lines = reportLines(analyze(verbatim, threeUnits), threeUnits);
  const verdicts = lines.filter((l) => l.startsWith('verdict:'));
  assert.equal(verdicts.length, 3);
  assert.match(verdicts[0] as string, /^verdict: cost C-A ratio 0\.5\d /);
  assert.match(verdicts[1] as string, /^verdict: cost C-B ratio 0\.5\d /);
  // A passes 2 of 3 rows, one of them regressed (33.3%); C passes 3 of 3, none regressed.
  assert.match(
    verdicts[2] as string,
    /^verdict: regression C-A -33\.3 pp \(A 33\.3%, B 0\.0%, C 0\.0%\)/,
  );
  assert.equal(
    lines.filter((l) => l.startsWith('secondary: pass rate')).length,
    2,
  );
  const r = analyze(verbatim, threeUnits);
  // Holm over the two cost contrasts never lowers a p value.
  for (const c of r.contrasts) assert.ok(c.costAdjustedP <= 1);
});

test('--report --metric c-cost-per-resolved-ratio prints one number, USD per resolved C over A', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abc-metric-'));
  const rowsFile = join(dir, 'rows.jsonl');
  writeFileSync(
    rowsFile,
    `${verbatim.map((r) => JSON.stringify(r)).join('\n')}\n`,
  );
  const prereg3 = join(dir, 'prereg.md');
  writeFileSync(
    prereg3,
    readFileSync(prereg, 'utf8')
      .split('\n')
      .filter((l) => !/^- t-/.test(l))
      .concat(['- t-1', '- t-2', '- t-3'])
      .join('\n'),
  );
  const out = spawnSync(
    process.execPath,
    [
      'evals/replay/run.ts',
      '--prereg',
      prereg3,
      '--report',
      '--metric',
      'c-cost-per-resolved-ratio',
      '--rows',
      rowsFile,
    ],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.equal(out.status, 0, out.stderr);
  // C spent 1.2 over 3 passes (0.4); A spent 2.3 over 2 passes (1.15).
  assert.equal(out.stdout.trim(), (0.4 / 1.15).toFixed(3));
});

test('a strict report over a partial matrix names only incomplete', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abc-strict-'));
  const realUnits = parsePrereg(readFileSync(prereg, 'utf8')).units;
  const rowsFile = join(dir, 'rows.jsonl');
  writeFileSync(
    rowsFile,
    `${verbatim.map((r) => JSON.stringify({ ...r, unit: realUnits[Number(r.unit.slice(2)) - 1], harness: 'abc123' })).join('\n')}\n`,
  );
  const text = readFileSync(prereg, 'utf8').replace(
    /^reps:.*$/m,
    'reps: 1\nharness-sha: abc123',
  );
  const pinned = join(dir, 'prereg.md');
  writeFileSync(pinned, text);
  const out = spawnSync(
    process.execPath,
    [
      'evals/replay/run.ts',
      '--prereg',
      pinned,
      '--report',
      '--strict',
      '--rows',
      rowsFile,
    ],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.equal(out.status, 65);
  assert.match(out.stderr, /verdict: matrix incomplete \(\d+ problems\)/);
  assert.doesNotMatch(out.stderr, /mixed|duplicate|harness|model/);
});

/** The first test's rows (C beats A and B on every unit) plus A' passing `aaPasses` of 3 on each unit. */
const withReplicate = (aaPasses: number, aaCost = 1): Row[] => {
  const base = frozen.units.flatMap((u, i) => [
    ...reps(u, 'C', 3, 1),
    ...reps(u, 'A', [0, 0, 1, 1][i] as number, 1),
    ...reps(u, 'B', [1, 1, 2, 2][i] as number, 1),
  ]);
  return [
    ...base,
    ...frozen.units.flatMap((u) => reps(u, "A'", aaPasses, aaCost)),
  ];
};

test("A'-A prints the flip rate and the paired difference, and A' stays out of the Holm family", () => {
  const plain = analyze(
    withReplicate(0).filter((r) => r.arm !== "A'"),
    frozen,
  );
  // A' repeats A exactly: passes [0,0,1,1] of 3 per unit.
  const rows = frozen.units.flatMap((u, i) => [
    ...withReplicate(0).filter((r) => r.unit === u && r.arm !== "A'"),
    ...reps(u, "A'", [0, 0, 1, 1][i] as number, 1),
  ]);
  const r = analyze(rows, frozen);
  assert.equal(r.aa?.flips, 0);
  assert.equal(r.aa?.pairs, 12);
  assert.equal(r.aa?.shown, false);
  // Holm m is still the two confirmatory contrasts: A' rows change none of their adjusted p.
  assert.deepEqual(
    r.contrasts.map((c) => [c.name, c.rawP, c.adjustedP, c.shown]),
    plain.contrasts.map((c) => [c.name, c.rawP, c.adjustedP, c.shown]),
  );
  const lines = reportLines(r, frozen);
  assert.ok(
    lines.some((l) => /^noise: A'-A flip rate 0\.0% \(0 of 12/.test(l)),
  );
  assert.ok(
    lines.some((l) =>
      /^noise: A'-A pass rate \+0\.0 pp, 95% CI .*outside the Holm family/.test(
        l,
      ),
    ),
  );
  assert.ok(lines.some((l) => /^noise: A'-A cost ratio 1\.00 /.test(l)));
  assert.ok(!lines.some((l) => l.includes('miscalibrated')));
});

test("A'-A shown at alpha flags the run miscalibrated and reads every contrast as not shown", () => {
  // A passes [0,0,1,1] of 3, A' passes 3 of 3 everywhere, at twice the cost: the replicate differs from A.
  const r = analyze(withReplicate(3, 2), frozen);
  assert.equal(r.aa?.shown, true);
  assert.ok((r.aa?.flipRate as number) > 0.5);
  assert.ok(r.contrasts.every((c) => !c.shown && !c.costShown));
  const lines = reportLines(r, frozen);
  assert.ok(
    lines.some((l) => /^noise: A'-A flip rate 83\.3% \(10 of 12/.test(l)),
  );
  assert.ok(lines.some((l) => /^verdict: miscalibrated/.test(l)));
  assert.ok(
    lines
      .filter((l) => l.startsWith('secondary: pass rate'))
      .every((l) => /, not shown /.test(l)),
  );
  // Without A' rows the report states it was not measured and the contrasts keep their verdicts.
  const none = analyze(
    withReplicate(3).filter((x) => x.arm !== "A'"),
    frozen,
  );
  assert.equal(none.aa, undefined);
  assert.equal(none.contrasts[0]?.shown, true);
  assert.ok(
    reportLines(none, frozen).some((l) =>
      l.startsWith("noise: A'-A not measured"),
    ),
  );
});

test("A'-A pairs only unit-reps graded under both arms and prints no cost ratio without priced pairs", () => {
  const same = withReplicate(0).filter((r) => r.arm !== "A'");
  const rows: Row[] = [
    ...frozen.units.flatMap((u, i) =>
      reps(u, "A'", [0, 0, 1, 1][i] as number, 1),
    ),
    ...same,
    // an A rep with no A' partner, passing where its unit's A' reps all fail
    {
      unit: 't-1',
      arm: 'A',
      rep: 4,
      pass: true,
      cost: 1,
      tokens: inputOnly(1),
      harness: 'h',
    },
  ];
  const r = analyze(rows, frozen);
  assert.equal(r.aa?.pairs, 12);
  assert.equal(r.aa?.shown, false);
  const unpriced = rows.map((x) => ({ ...x, tokens: null }));
  const line = reportLines(analyze(unpriced, frozen), frozen).find((l) =>
    l.startsWith("noise: A'-A cost ratio"),
  );
  assert.match(line as string, /cost ratio n\/a/);
});
