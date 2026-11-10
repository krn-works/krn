import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dollarsPerPoint,
  parsePlanSamples,
  planPoints,
} from '../../src/outcome/plan-gauge.ts';

const row = (time: string, five: number, seven: number, s = 'a') =>
  JSON.stringify({ time, session: s, five_hour: five, seven_day: seven });

const rows = parsePlanSamples(
  [
    row('2026-11-10T09:00:00Z', 10, 50),
    row('2026-11-10T09:10:00Z', 30, 52),
    // a stale session reports old values
    row('2026-11-10T09:11:00Z', 88, 40, 'stale'),
    row('2026-11-10T09:20:00Z', 60, 55),
    // five-hour window reset adds nothing
    row('2026-11-10T09:30:00Z', 5, 56),
    row('2026-11-10T09:40:00Z', 15, 58),
    'not json',
  ].join('\n'),
);

test('plan points sum rises, drop stale rows and ignore a window reset', () => {
  const p = planPoints(
    rows,
    Date.parse('2026-11-10T09:05:00Z'),
    Date.parse('2026-11-10T10:00:00Z'),
  );
  assert.deepEqual(p, { samples: 4, fiveHour: 20 + 30 + 10, sevenDay: 8 });
});

test('dollars per point for both windows, null when no points moved', () => {
  assert.deepEqual(
    dollarsPerPoint(120, { samples: 4, fiveHour: 60, sevenDay: 8 }),
    { fiveHour: 2, sevenDay: 15 },
  );
  assert.deepEqual(
    dollarsPerPoint(5, { samples: 0, fiveHour: 0, sevenDay: 0 }),
    { fiveHour: null, sevenDay: null },
  );
});
