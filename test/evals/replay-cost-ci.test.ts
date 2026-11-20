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
import {
  LIST_PRICES,
  NO_CACHE_DISCOUNT,
} from '../../evals/replay/token-cost.ts';
import { inputOnly } from './token-fixture.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));

const frozen: Prereg = {
  prices: LIST_PRICES,
  sensitivity: NO_CACHE_DISCOUNT,
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
      [1, 2].map((rep) => {
        const usd =
          (unitCost[unit] as number) * armFactor[arm] * (1 + rep / 10);
        // total_cost_usd is deliberately not the priced tokens: the report must not read it.
        return {
          unit,
          arm,
          rep,
          pass: !(arm === 'A' && rep === 1),
          cost: usd * 7,
          tokens: inputOnly(usd),
          harness: 'a1',
          model: 'sonnet',
        };
      }),
    ),
  );

const prereg = [
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
  const lines = result.stdout.split('\n');
  const cost = lines.filter((l) => l.startsWith('verdict: cost'));
  const sens = lines.filter((l) => l.startsWith('sensitivity: cost'));
  assert.equal(cost.length, 2);
  assert.equal(sens.length, 2);
  for (const l of [...cost, ...sens]) {
    assert.match(l, /95% CI \[-?\d+\.\d+, -?\d+\.\d+\]/);
    assert.match(l, /Holm p \d/);
    assert.match(l, /n 3 units/);
  }
  // The ratio is exactly 0.5 for C over A in every unit, so its CI collapses onto it.
  assert.match(cost[0] as string, /ratio 0\.50 /);
  for (const arm of ['A', 'B', 'C'])
    assert.match(
      result.stdout,
      new RegExp(
        `cost: at cost-sensitivity USD per resolved ${arm} \\d+\\.\\d+ 95% CI \\[`,
      ),
    );
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

test('a row with cost but no tokens fails --report --strict naming the row', () => {
  const rows = complete().map((r) =>
    r.unit === 't-bb' && r.arm === 'C' && r.rep === 2
      ? { ...r, tokens: null }
      : r,
  );
  const result = report(rows, true);
  assert.equal(result.status, 65);
  assert.match(
    result.stderr,
    /no tokens for t-bb C rep 2 \(total_cost_usd [\d.]+/,
  );
  assert.doesNotMatch(result.stdout, /verdict: cost/);
});

test('without --strict a missing cost shrinks the pair and the unit count says so', () => {
  const rows = complete().map((r) =>
    r.unit === 't-bb' && r.arm === 'C' ? { ...r, tokens: null } : r,
  );
  const result = report(rows, false);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verdict: cost C-A .*n 2 units/);
});

test('cost is the row tokens at the prereg vector, not total_cost_usd, and the reported cost is a descriptive column', () => {
  const result = report(complete(), true);
  const lines = result.stdout.split('\n');
  // Reported cost is 7x the priced tokens: USD per resolved differs by exactly that factor.
  const usd = (head: string) =>
    Number(new RegExp(`${head} A (\\d+\\.\\d+)`).exec(result.stdout)?.[1]);
  const priced = usd('cost: USD per resolved task');
  const reported = usd('cost: reported total_cost_usd per resolved task');
  assert.ok(priced > 0);
  assert.ok(Math.abs(reported / priced - 7) < 0.01, `${reported} vs ${priced}`);
  assert.ok(lines.some((l) => /\(descriptive only\)$/.test(l)));
});

/** C reads ten times A's input as cache: half A's cost at list prices, ten times it without the cache discount. */
const cacheHeavy = (): Row[] =>
  complete().map((r) => {
    if (r.arm !== 'C') return r;
    const usd = (unitCost[r.unit] as number) * (1 + r.rep / 10);
    return {
      ...r,
      tokens: {
        ...inputOnly(0),
        cacheRead: ((usd * 0.5) / 0.1) * 1e6,
      },
    };
  });

test('a cost verdict that differs between the vectors is marked cache-dependent', () => {
  const result = report(cacheHeavy(), true);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split('\n');
  const at = (head: string) =>
    lines.filter((l) => l.startsWith(head) && / C-A /.test(l));
  assert.match(at('verdict: cost')[0] as string, / shown .*cache-dependent$/);
  assert.match(
    at('sensitivity: cost')[0] as string,
    /ratio 10\.00 .*not shown .*cache-dependent$/,
  );
  // C-B too is cache-dependent here; a run where both vectors agree carries no flag.
  const plain = report(complete(), true).stdout;
  assert.doesNotMatch(plain, /cache-dependent/);
});

test('the prereg vectors must equal token-cost.ts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-cost-ci-'));
  writeFileSync(
    join(dir, 'prereg.md'),
    prereg.replace('cache-read 0.1,', 'cache-read 0.2,'),
  );
  writeFileSync(join(dir, 'rows.jsonl'), '');
  const r = spawnSync(
    process.execPath,
    [
      join(repo, 'evals/replay/run.ts'),
      '--prereg',
      join(dir, 'prereg.md'),
      '--report',
      '--rows',
      join(dir, 'rows.jsonl'),
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cost-prices .* differs from token-cost\.ts/);
});
