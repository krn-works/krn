import assert from 'node:assert/strict';
import { existsSync, globSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import * as planner from '../scripts/lib/test-shards.mjs';

const options = (files) => ({ durations: { version: 1, files } });
test('default lanes follow cores', () => {
  for (const [cores, lanes] of [
    [8, 7],
    [16, 15],
    [2, 1],
    [1, 1],
    [0, 1],
    [NaN, 1],
  ])
    assert.equal(planner.defaultTestShardCount(cores), lanes);
});
test('schedule keeps scope files together and exclusives after concurrent lanes', () => {
  assert.equal(typeof planner.scheduleTestGroups, 'function');
  const files = globSync('test/**/*.test.{ts,js,mjs,cjs}').sort();
  const plan = planner.planTestShards(files, 7);
  const phases = planner.scheduleTestGroups(plan, 7);
  assert.equal(phases[0].length, 7);
  assert.deepEqual(
    phases[0][0].files.slice(0, plan.laneFiles.length),
    [...planner.SCOPE_LANE_TEST_FILES].sort(),
  );
  assert.deepEqual(phases[1], [
    { files: [...planner.EXCLUSIVE_TEST_FILES].sort() },
  ]);
  const planned = phases.flat().flatMap((group) => group.files);
  assert.deepEqual([...planned].sort(), files);
  assert.equal(new Set(planned).size, files.length);
  for (const file of [
    ...planner.SCOPE_LANE_TEST_FILES,
    ...planner.EXCLUSIVE_TEST_FILES,
  ])
    assert.ok(existsSync(file));
  const single = planner.scheduleTestGroups(
    planner.planTestShards(files, 1),
    1,
  );
  assert.equal(single.length, 1);
  assert.equal(single[0].length, 1);
  assert.deepEqual(
    single[0][0].files.slice(-plan.exclusiveFiles.length),
    plan.exclusiveFiles,
  );
  assert.deepEqual([...single[0][0].files].sort(), files);
});
test('LPT balances durations and preloads the scope lane', () => {
  assert.equal(typeof planner.scheduleTestGroups, 'function');
  assert.deepEqual(
    planner.planTestShards(
      ['a', 'b', 'c', 'd'],
      2,
      options({ a: 100, b: 90, c: 60, d: 40 }),
    ).shards,
    [
      ['a', 'd'],
      ['b', 'c'],
    ],
  );
  const plan = planner.planTestShards(['L', 'a', 'b'], 2, {
    ...options({ L: 150, a: 100, b: 60 }),
    laneFiles: ['L'],
  });
  assert.deepEqual(plan.shards, [['L'], ['a', 'b']]);
  assert.equal(planner.scheduleTestGroups(plan, 2).length, 1);
});
test('unknown files use selected median; malformed durations never lose files', () => {
  assert.deepEqual(
    planner.planTestShards(
      ['a', 'b', 'c', 'd'],
      2,
      options({ a: 100, b: 20, d: 40, unrelated: 99999 }),
    ).shards,
    [['a'], ['c', 'd', 'b']],
  );
  for (const durations of [
    null,
    [],
    {},
    { version: 2, files: { a: 10 } },
    { version: 1, files: null },
    { version: 1, files: { a: -1, b: 1.5, c: '3', d: Number.MAX_VALUE } },
  ]) {
    const plan = planner.planTestShards(['a', 'b', 'c', 'd'], 2, { durations });
    assert.deepEqual(plan.shards, [
      ['a', 'c'],
      ['b', 'd'],
    ]);
  }
  assert.deepEqual(
    planner.planTestShards(['a', 'b'], 99, {
      durationsPath: '/missing/durations.json',
    }).shards,
    [['a'], ['b']],
  );
});

test('file sizes do not override timings and unreadable JSON uses equal weights', async () => {
  await mkdir('.krn/tmp', { recursive: true });
  const root = await mkdtemp('.krn/tmp/shard-weights-');
  try {
    const files = ['a', 'b', 'c', 'd'].map((name) => join(root, name));
    for (const [i, file] of files.entries())
      await writeFile(file, 'x'.repeat(i + 1));
    const table = Object.fromEntries(
      files.map((file, i) => [file, [100, 90, 60, 40][i]]),
    );
    assert.deepEqual(planner.planTestShards(files, 2, options(table)).shards, [
      [files[0], files[3]],
      [files[1], files[2]],
    ]);
    const path = join(root, 'durations.json');
    await writeFile(path, '{invalid');
    assert.deepEqual(
      planner.planTestShards(files, 2, { durationsPath: path }).shards,
      [
        [files[0], files[2]],
        [files[1], files[3]],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
