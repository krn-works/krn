import assert from 'node:assert/strict';
import test from 'node:test';
import { TEST_FILE_WEIGHTS } from '../../scripts/lib/shard-weights.mjs';
import {
  pearson,
  predictShardWall,
  renderReport,
  shardWallReport,
} from '../../scripts/shard-wall-report.mjs';

test('pearson r is 1 for a linear relation and -1 for an inverse one', () => {
  assert.equal(pearson([1, 2, 3], [2, 4, 6]).toFixed(6), '1.000000');
  assert.equal(pearson([1, 2, 3], [6, 4, 2]).toFixed(6), '-1.000000');
  assert.ok(Number.isNaN(pearson([1], [1])));
});

// Derived from the live weights so a weight refresh never breaks the tests.
const byWeight = Object.keys(TEST_FILE_WEIGHTS).sort(
  (a, b) => TEST_FILE_WEIGHTS[b] - TEST_FILE_WEIGHTS[a],
);
const heavy = byWeight[0];
const light = byWeight.slice(-3);

test('predicted shard wall is the heaviest local lane, not the summed weight', () => {
  const files = [heavy, ...light];
  const summed = files.reduce((sum, file) => sum + TEST_FILE_WEIGHTS[file], 0);
  assert.equal(predictShardWall(files, 4), TEST_FILE_WEIGHTS[heavy]);
  assert.ok(Math.abs(predictShardWall(files, 1) - summed) < 1e-9);
});

test('report pairs CI step seconds with predictions and gates the slowest p50', () => {
  const job = (name, seconds, files) => ({
    name,
    seconds,
    summary: {
      files: files.map((file) => ({
        file: `/home/runner/work/krn/krn/${file}`,
        durationMs: 1000,
      })),
    },
  });
  const runs = ['1', '2', '3'].map((id, index) => ({
    id,
    jobs: [
      job('Test (1/2)', 20 + index, [heavy]),
      job('Test (2/2)', 10 + index, [light[0]]),
      job('Test (3/3)', undefined, [light[1]]),
    ],
  }));
  const report = shardWallReport(runs, 4);
  assert.equal(report.rows.length, 6);
  assert.equal(report.rows[0].predicted, TEST_FILE_WEIGHTS[heavy]);
  assert.ok(report.laneR > 0.9);
  assert.equal(report.slowestP50, 21);
  const rendered = renderReport(report);
  assert.match(rendered, /heaviest-lane model: r=0\.\d+ \(strong\)/u);
  assert.match(rendered, /slowest Test step p50: 21 s, target < 24 s: PASS/u);
});
