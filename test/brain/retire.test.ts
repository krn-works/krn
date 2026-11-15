import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Exposure, exposureOf } from '../../src/brain/exposures.ts';
import {
  fisherBenefitP,
  recordsInForce,
  retirable,
  retireInFile,
} from '../../src/brain/retire.ts';
import { heldOut } from '../../src/brain/worker-packet.ts';

/** One run of a distinct task in which `id` was served or withheld and its own check did or did not fail. */
function run(
  n: number,
  arm: 'served' | 'withheld',
  id: string,
  violated: boolean | null,
): Exposure {
  return exposureOf({
    run: `run-${n}`,
    task: `t-${n}`,
    channel: 'lane',
    served: arm === 'served' ? [id] : [],
    withheld: arm === 'withheld' ? [id] : [],
    laneOk: true,
    violated: { [id]: violated },
  });
}

function runs(
  id: string,
  arm: 'served' | 'withheld',
  count: number,
  violatedCount: number,
  from: number,
): Exposure[] {
  return Array.from({ length: count }, (_, i) =>
    run(from + i, arm, id, i < violatedCount),
  );
}

test('the holdout is a pure function of task and record that withholds about one record in ten', () => {
  assert.equal(heldOut('t-abc1234', 'r-a'), heldOut('t-abc1234', 'r-a'));
  let held = 0;
  const total = 5000;
  for (let i = 0; i < total; i++) if (heldOut(`t-${i}`, 'r-a')) held++;
  assert.ok(held > 0.08 * total && held < 0.12 * total, `held ${held}`);
  const ids = Array.from({ length: 200 }, (_, i) => `r-${i}`);
  const first = ids.filter((id) => heldOut('t-fixed', id));
  assert.deepEqual(
    first,
    ids.filter((id) => heldOut('t-fixed', id)),
  );
  assert.ok(first.length > 0 && first.length < 40, `held ${first.length}`);
});

test('Fisher one-sided p matches the hand-computed tables', () => {
  // 0 of 5 versus 5 of 5: C(5,0)C(5,5)/C(10,5) = 1/252.
  assert.ok(Math.abs(fisherBenefitP(0, 5, 5, 5) - 1 / 252) < 1e-12);
  // Equal rates: p is above one half.
  assert.ok(fisherBenefitP(5, 10, 5, 10) > 0.5);
  // Served worse than withheld: no evidence of benefit, p near 1.
  assert.ok(fisherBenefitP(10, 10, 0, 10) > 0.99);
});

test('retire selects exactly the in-force record with enough scoped diffs and no benefit under Fisher', () => {
  const exposures: Exposure[] = [
    // r-useless: 30 served (half violated), 10 withheld (half violated).
    ...runs('r-useless', 'served', 30, 15, 0),
    ...runs('r-useless', 'withheld', 10, 5, 100),
    // r-useful: served never violated, withheld always: a clear benefit.
    ...runs('r-useful', 'served', 30, 0, 200),
    ...runs('r-useful', 'withheld', 10, 10, 300),
    // r-thin: no benefit but only 9 withheld.
    ...runs('r-thin', 'served', 30, 15, 400),
    ...runs('r-thin', 'withheld', 9, 4, 500),
    // r-few: no benefit but only 29 served.
    ...runs('r-few', 'served', 29, 15, 600),
    ...runs('r-few', 'withheld', 10, 5, 700),
    // r-gone: no benefit but already retired (not in force).
    ...runs('r-gone', 'served', 30, 15, 800),
    ...runs('r-gone', 'withheld', 10, 5, 900),
    // r-prose: plenty of exposures but no check ever ran: nothing to judge.
    ...Array.from({ length: 40 }, (_, i) =>
      run(1000 + i, i < 30 ? 'served' : 'withheld', 'r-prose', null),
    ),
  ];
  const inForce = new Set([
    'r-useless',
    'r-useful',
    'r-thin',
    'r-few',
    'r-prose',
  ]);
  assert.deepEqual(retirable(exposures, inForce), ['r-useless']);
});

test('a record served on a task and rerun counts once, so reruns cannot reach the threshold', () => {
  const exposures: Exposure[] = [
    ...runs('r-a', 'served', 28, 14, 0),
    ...Array.from({ length: 5 }, (_, i) =>
      exposureOf({
        run: `again-${i}`,
        task: 't-again',
        channel: 'lane',
        served: ['r-a'],
        withheld: [],
        attempt: i + 1,
        laneOk: true,
        violated: { 'r-a': true },
      }),
    ),
    ...runs('r-a', 'withheld', 10, 5, 100),
  ];
  assert.deepEqual(retirable(exposures, new Set(['r-a'])), []);
});

test('retire --write sets valid_to on the chosen rows only and keeps the file a records array', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retire-'));
  try {
    const file = join(dir, 'records.json');
    const row = (id: string) => ({
      id,
      type: 'convention',
      text: `Rule ${id}.`,
      recorded_at: '2026-01-01',
      valid_from: '2026-01-01',
      valid_to: null,
      source: 'AGENTS.md',
    });
    writeFileSync(file, JSON.stringify([row('r-a'), row('r-b')]));
    assert.deepEqual(recordsInForce(file, '2026-11-14'), ['r-a', 'r-b']);
    assert.deepEqual(retireInFile(file, new Set(['r-a']), '2026-11-14'), [
      'r-a',
    ]);
    const rows = JSON.parse(readFileSync(file, 'utf8')) as {
      id: string;
      valid_to: string | null;
    }[];
    assert.deepEqual(
      rows.map((r) => [r.id, r.valid_to]),
      [
        ['r-a', '2026-11-14'],
        ['r-b', null],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
