import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Row } from '../../evals/replay/rows.ts';
import {
  eligible,
  parseRows,
  report,
  type ScreenUnit,
  screen,
} from '../../evals/replay/screen.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));

const unit = (n: number, over: Partial<ScreenUnit> = {}): ScreenUnit => ({
  id: `t-${String(n).padStart(7, '0')}`,
  repo: 'o/r',
  base: 'a'.repeat(40),
  reference: 'b'.repeat(40),
  task: { title: 't', body: 'Why: the bug in the issue' },
  spec: 's',
  hidden: { file: 'hidden.txt', dest: 'x' },
  install: 'i',
  test: 't',
  committed: '2026-08-01',
  issue: `https://github.com/o/r/issues/${n}`,
  ...over,
});
const units = (n: number) => Array.from({ length: n }, (_, i) => unit(i));
const row = (u: ScreenUnit, pass: boolean | null, arm = 'A'): Row => ({
  unit: u.id,
  arm: arm as Row['arm'],
  rep: 1,
  pass,
  cost: 0,
  harness: 'x',
});

test('only post-cutoff units with an issue-only body are eligible', () => {
  const list = [
    unit(1),
    unit(2, { committed: '2026-05-31' }),
    unit(3, { committed: undefined }),
    unit(4, { issue: undefined }),
    unit(5, { task: { title: 't', body: 'Outcome: spec leaked' } }),
  ];
  assert.deepEqual(
    eligible(list).map((u) => u.id),
    [unit(1).id],
  );
});

test('fewer than 70 eligible units is no-go whatever A scored', () => {
  const us = units(69);
  const s = screen(
    us,
    us.map((u) => row(u, false)),
  );
  assert.equal(s.verdict, 'no-go');
  assert.match(s.reason, /69 eligible units, 70 required/);
});

test('70 units with A at 85% is go and above 85% is no-go', () => {
  const us = units(100).slice(0, 70);
  const at = (passes: number) =>
    screen(
      us,
      us.map((u, i) => row(u, i < passes)),
    );
  assert.equal(at(59).verdict, 'go'); // 84.3%
  assert.equal(at(60).verdict, 'no-go'); // 85.7%
});

test('unscreened units are pending and other arms are ignored', () => {
  const us = units(70);
  assert.equal(screen(us, []).verdict, 'pending');
  const s = screen(
    us,
    us.map((u) => row(u, true, 'C')),
  );
  assert.equal(s.passRate, null);
  assert.match(report(s).join('\n'), /A pass rate: unmeasured/);
});

test('rows file lines parse and the report prints rate and verdict', () => {
  const us = units(70);
  const text = us.map((u, i) => JSON.stringify(row(u, i % 2 === 0))).join('\n');
  const s = screen(us, parseRows(text));
  const out = report(s).join('\n');
  assert.match(out, /A pass rate: 50\.0% \(70 screened\)/);
  assert.match(out, /verdict: go/);
});

test('the proof command prints the rate line and a verdict', () => {
  const r = spawnSync('node', ['evals/replay/run.ts', '--screen', '--report'], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^A pass rate: /m);
  assert.match(r.stdout, /^verdict: (go|no-go|pending) /m);
});
