import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Exposure } from '../../src/brain/exposures.ts';
import {
  recordsInForce,
  retirable,
  retireInFile,
} from '../../src/brain/retire.ts';
import { heldOut } from '../../src/brain/worker-packet.ts';

function run(
  n: number,
  served: string[],
  withheld: string[],
  laneOk: boolean,
): Exposure {
  return {
    run: `run-${n}`,
    task: `t-${n}`,
    channel: 'lane',
    served,
    withheld,
    outcome: Object.fromEntries(
      served.map((id) => [id, laneOk ? 'followed' : 'violated']),
    ),
    lane_ok: laneOk,
    rework: laneOk ? 0 : 1,
  };
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

test('retire selects exactly the record whose served runs do no better than its withheld runs', () => {
  const exposures: Exposure[] = [];
  let n = 0;
  // r-useless: 27 served (half ok) and 3 withheld (all ok) is no benefit; r-useful: served always ok, withheld always fails;
  // r-thin: no effect but only 10 exposures; r-gone: no effect but already retired (not in force).
  for (let i = 0; i < 27; i++)
    exposures.push(
      run(n++, ['r-useless', 'r-useful'], [], i % 2 === 0),
      run(n++, ['r-useful'], [], true),
    );
  for (let i = 0; i < 3; i++)
    exposures.push(run(n++, [], ['r-useless', 'r-gone'], true));
  for (let i = 0; i < 3; i++) exposures.push(run(n++, [], ['r-useful'], false));
  for (let i = 0; i < 27; i++) exposures.push(run(n++, ['r-gone'], [], false));
  for (let i = 0; i < 7; i++) exposures.push(run(n++, ['r-thin'], [], false));
  for (let i = 0; i < 3; i++) exposures.push(run(n++, [], ['r-thin'], true));
  const inForce = new Set(['r-useless', 'r-useful', 'r-thin']);
  assert.deepEqual(retirable(exposures, inForce), ['r-useless']);
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
