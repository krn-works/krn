import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  gradePreflight,
  judge,
  preflightOnce,
} from '../../evals/replay/grade-preflight.ts';
import type { LiveUnit } from '../../evals/replay/live.ts';
import { attemptLines, firstFailingLine } from '../../evals/replay/screen.ts';
import { type Grade, lastLines } from '../../evals/units/screening.ts';

const g = (
  install: number,
  test: number,
  tail = '',
  compile = false,
): Grade => ({
  install,
  test,
  compile,
  tail,
});

const lu = (id: string): LiveUnit =>
  ({
    unit: { id, base: 'b'.repeat(40), reference: 'r'.repeat(40) },
    dir: '/units',
  }) as unknown as LiveUnit;

test('the grade preflight passes a unit red by assertion at base and green at the reference', () => {
  assert.deepEqual(judge(g(0, 1), g(0, 0)), { ok: true, reasons: [] });
});

test('the grade preflight screens a unit whose reference fails the grader, keeping the reference output tail', () => {
  const c = judge(g(0, 1, 'base out'), g(0, 1, 'FAIL test/utils/Data.spec.ts'));
  assert.equal(c.ok, false);
  assert.deepEqual(c.reasons, ['reference fails the grader (exit 1)']);
  assert.equal(c.tail, 'FAIL test/utils/Data.spec.ts');
  assert.deepEqual(judge(g(0, 1), g(2, -1)).reasons, [
    'reference install exit 2',
  ]);
});

test('the grade preflight screens a base that passes, times out or does not load', () => {
  assert.deepEqual(judge(g(0, 0), g(0, 0)).reasons, [
    'hidden test passes at base',
  ]);
  assert.deepEqual(judge(g(0, 124), g(0, 0)).reasons, [
    'hidden test timed out at base',
  ]);
  assert.deepEqual(judge(g(0, 1, '', true), g(0, 0)).reasons, [
    'hidden test does not load at base',
  ]);
  assert.deepEqual(judge(g(1, -1), g(0, 0)).reasons, ['base install exit 1']);
});

test('the grade preflight grades base then reference once per unit, however many reps ask', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grade-preflight-'));
  try {
    const calls: string[] = [];
    const check = preflightOnce(async (sha, u) => {
      calls.push(`${u.unit.id}@${sha[0]}`);
      return sha.startsWith('b') ? g(0, 1) : g(0, 1, 'not ok 1 - fix');
    }, dir);
    const [a, b] = await Promise.all([check(lu('t-x')), check(lu('t-x'))]);
    assert.equal(a, b);
    assert.deepEqual(calls, ['t-x@b', 't-x@r']);
    assert.match(
      readFileSync(join(dir, 't-x-preflight.log'), 'utf8'),
      /preflight t-x: screened \(reference fails the grader \(exit 1\)\)/,
    );
    const direct = await gradePreflight(
      lu('t-y'),
      async () => g(0, 1),
      join(dir, 'y.log'),
    );
    assert.deepEqual(direct.reasons, ['reference fails the grader (exit 1)']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a grade keeps the last 40 lines of the grader output', () => {
  const out = `${Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n')}\n\n`;
  const tail = lastLines(out).split('\n');
  assert.equal(tail.length, 40);
  assert.equal(tail[0], 'line 61');
  assert.equal(tail.at(-1), 'line 100');
});

test('the attempt line names the first failing line of a hand-written go, jest and pytest grade tail', () => {
  const go =
    'time="2026-11-18T13:02:59+01:00" level=info msg="failed to fetch urunc annotations"\n=== RUN   TestUruncConfigFromMap\n--- FAIL: TestUruncConfigFromMap (0.00s)\n    urunc_config_test.go:90: want 2\nFAIL\nFAIL\tgithub.com/urunc-dev/urunc/pkg/unikontainers\t0.02s';
  assert.equal(
    firstFailingLine(go),
    '--- FAIL: TestUruncConfigFromMap (0.00s)',
  );
  const jest =
    ' PASS  test/a.spec.ts\n FAIL  test/utils/Data.spec.ts\n  ● Data › keeps typed arrays\nTests:       1 failed, 7 passed, 8 total';
  assert.equal(firstFailingLine(jest), 'FAIL  test/utils/Data.spec.ts');
  assert.equal(
    firstFailingLine('collected 3 items\nE   AssertionError: 1 != 2\n'),
    'E   AssertionError: 1 != 2',
  );
  assert.equal(firstFailingLine('ok  \tpkg\t0.1s\nPASS'), undefined);
  const [line] = attemptLines([
    {
      unit: 't-x',
      arm: 'A',
      rep: 1,
      pass: false,
      cost: 1,
      harness: 'h',
      verdict: 'fail',
      gradeTail: go,
    },
  ]);
  assert.match(
    line as string,
    /verdict=fail grade: --- FAIL: TestUruncConfigFromMap \(0\.00s\)$/,
  );
});
