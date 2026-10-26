import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  formatSlowestTests,
  slowestTests,
} from '../scripts/lib/test-timings.mjs';

test('slowest tests rank ten top-level terminal outcomes by duration, file and name', () => {
  const root = resolve('fixture-project');
  const outcome = (name, file, duration_ms, extra = {}) => ({
    type: 'test:pass',
    data: {
      name,
      file: join(root, file),
      nesting: 0,
      details: { duration_ms },
      ...extra,
    },
  });
  const events = [
    outcome('last name', 'test/z.test.mjs', 2000),
    outcome('z name', 'test/a.test.mjs', 2000),
    outcome('a name', 'test/a.test.mjs', 2000),
    { ...outcome('failed', 'test/failure.test.mjs', 3000), type: 'test:fail' },
    outcome('nested', 'test/parent.test.mjs', 9999, { nesting: 1 }),
    outcome('missing', 'test/missing.test.mjs', undefined),
    outcome('invalid', 'test/invalid.test.mjs', '4000'),
    outcome('infinite', 'test/infinite.test.mjs', Infinity),
    outcome('negative', 'test/negative.test.mjs', -1),
    {
      ...outcome('not terminal', 'test/start.test.mjs', 9999),
      type: 'test:start',
    },
    outcome('wrapped', 'preload.mjs', 4000, {
      entryFile: join(root, 'test/actual.test.mjs'),
    }),
    ...Array.from({ length: 10 }, (_, index) =>
      outcome(`tail ${index}`, `test/tail-${index}.test.mjs`, index),
    ),
  ];
  const ranked = slowestTests(events, root);
  assert.equal(ranked.length, 10);
  assert.deepEqual(
    ranked.slice(0, 5).map(({ name, file }) => ({ name, file })),
    [
      { name: 'wrapped', file: 'test/actual.test.mjs' },
      { name: 'failed', file: 'test/failure.test.mjs' },
      { name: 'a name', file: 'test/a.test.mjs' },
      { name: 'z name', file: 'test/a.test.mjs' },
      { name: 'last name', file: 'test/z.test.mjs' },
    ],
  );
  assert.deepEqual(
    ranked.slice(5).map(({ duration_ms }) => duration_ms),
    [9, 8, 7, 6, 5],
  );
  assert.deepEqual(slowestTests([...events].reverse(), root), ranked);
});

test('slowest tests handle zero, missing and fewer than ten durations and escape table cells', () => {
  assert.deepEqual(slowestTests([]), []);
  assert.match(formatSlowestTests([]), /No test durations recorded\./u);
  const ranked = slowestTests([
    {
      type: 'test:pass',
      data: { name: 'no details', file: 'test/a.mjs', nesting: 0 },
    },
    {
      type: 'test:pass',
      data: {
        name: 'zero|time\nname',
        file: 'test/a|b.mjs',
        nesting: 0,
        details: { duration_ms: 0 },
      },
    },
  ]);
  assert.equal(ranked.length, 1);
  assert.ok(
    formatSlowestTests(ranked).includes(
      '| zero\\|time name | test/a\\|b.mjs | 0.000 |',
    ),
  );
});
