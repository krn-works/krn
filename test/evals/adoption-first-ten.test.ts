import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const script = join(repo, 'evals/adoption/first-ten.ts');

interface Spec {
  adopters?: number;
  tasks?: number;
  cFails?: number;
  bFails?: number;
  cCost?: number | null;
}

/** Hand-written cohort rows: each adopter's tasks, C and B on one SHA, the first `cFails`/`bFails` tasks failing. */
function cohort({
  adopters = 3,
  tasks = 10,
  cFails = 0,
  bFails = 0,
  cCost = 0.6,
}: Spec): string {
  const lines: string[] = [];
  for (let a = 1; a <= adopters; a++)
    for (let seq = 1; seq <= tasks; seq++)
      for (const arm of ['C', 'B']) {
        const fails = arm === 'C' ? cFails : bFails;
        lines.push(
          JSON.stringify({
            unit: `a${a}-t${seq}`,
            arm,
            rep: 1,
            pass: seq > fails,
            cost: arm === 'C' ? cCost : 0.5,
            harness: 'h',
            adopter: `a${a}`,
            seq,
            sha: `sha${a}${seq}`,
          }),
        );
      }
  return lines.join('\n');
}

function report(rows: string, args: string[] = []) {
  const file = join(mkdtempSync(join(tmpdir(), 'first-ten-')), 'rows.jsonl');
  writeFileSync(file, rows);
  const r = spawnSync(
    process.execPath,
    [script, '--report', '--rows', file, ...args],
    { encoding: 'utf8' },
  );
  return { out: r.stdout.trim(), err: r.stderr, status: r.status };
}

test('the recorded cohort fixture prints PASS', () => {
  const r = spawnSync(process.execPath, [script, '--report'], {
    encoding: 'utf8',
  });
  assert.equal(r.stdout.trim(), 'PASS');
  assert.equal(r.status, 0);
});

test('a clear benefit at modest cost prints PASS', () => {
  assert.equal(report(cohort({ bFails: 5 })).out, 'PASS');
});

test('no benefit prints FAIL', () => {
  const r = report(cohort({ cFails: 2, bFails: 2 }));
  assert.equal(r.out, 'FAIL');
  assert.equal(r.status, 1);
});

test('a benefit that costs more than the frozen ratio prints FAIL', () => {
  assert.equal(report(cohort({ bFails: 5, cCost: 0.9 })).out, 'FAIL');
});

test('too few adopters or an unfinished first ten prints INSUFFICIENT', () => {
  const two = report(cohort({ adopters: 2, bFails: 5 }));
  assert.equal(two.out, 'INSUFFICIENT');
  assert.equal(two.status, 65);
  assert.equal(report(cohort({ tasks: 9, bFails: 5 })).out, 'INSUFFICIENT');
  assert.equal(report('').out, 'INSUFFICIENT');
});

test('an unknown cost prints INSUFFICIENT', () => {
  assert.equal(report(cohort({ bFails: 5, cCost: null })).out, 'INSUFFICIENT');
});

test('a weak benefit between the PASS and FAIL conditions prints INSUFFICIENT', () => {
  // 4 failures of B against none of C in 30 pairs: p is about 0.056, above alpha and below fail-p.
  const mid = cohort({ adopters: 3 })
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const failing = new Set(['a1-t1', 'a1-t2', 'a1-t3', 'a2-t1']);
  const text = mid
    .map((row) =>
      JSON.stringify({
        ...row,
        pass: !(row.arm === 'B' && failing.has(row.unit as string)),
      }),
    )
    .join('\n');
  assert.equal(report(text).out, 'INSUFFICIENT');
});

test('stdout is exactly one verdict word', () => {
  assert.match(report(cohort({ bFails: 5 })).out, /^(PASS|FAIL|INSUFFICIENT)$/);
});
