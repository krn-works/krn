import assert from 'node:assert/strict';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TEST_FILE_WEIGHTS } from '../../scripts/lib/shard-weights.mjs';
import { fileWeight } from '../../scripts/lib/test-shards.mjs';
import {
  MAX_SHARD_WEIGHT_SECONDS,
  MAX_TEST_FILE_SECONDS,
} from '../../scripts/shard-wall-report.mjs';
import { selectTestFiles } from '../../scripts/test-suite.mjs';

// A rule test so `npm run fast` runs it whenever a test file is added or removed.
const root = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));

// A new test file needs no hand-written weight: the sharder weighs it by size
// until `scripts/shard-weights-refresh.mjs --write` records CI samples. Only a
// weight naming a deleted file is an error.
const files = selectTestFiles([], root).map((file) =>
  relative(root, file).split(sep).join('/'),
);

test('no weight names a deleted test file', () => {
  assert.deepEqual(
    Object.keys(TEST_FILE_WEIGHTS).filter((file) => !files.includes(file)),
    [],
    'weights name deleted test files',
  );
});

// The heaviest test file bounds its CI shard wall (MAX_TEST_FILE_SECONDS in
// scripts/shard-wall-report.mjs, whose `files over the 11 s bound` line holds
// CI medians to it). Keep every file under the bound by splitting it. Weights
// are CI-measured (`node scripts/shard-weights-refresh.mjs --write`) under
// 4-lane contention, about 2x a local estimate, so a split's local-estimate
// weights must be refreshed from CI before they are trusted.

test('no test file is heavy enough to bound its shard wall', () => {
  assert.deepEqual(
    Object.entries(TEST_FILE_WEIGHTS)
      .filter(([, seconds]) => seconds > MAX_TEST_FILE_SECONDS)
      .map(([file]) => file),
    [],
    `split test files above ${MAX_TEST_FILE_SECONDS} s so the slowest shard stays near that bound`,
  );
});

// Tests grow the suite between weight refreshes (weighted or not); once the summed weight per
// CI shard passes the bound, the mean shard reaches the 18 s target and only
// another shard restores it.
test('the CI shard count keeps the summed weight per shard within its bound', () => {
  const workflow = readFileSync(`${root}/.github/workflows/ci.yml`, 'utf8');
  const shards = Number(
    /^ {6}KRN_TEST_SHARD_TOTAL: '(\d+)'$/mu.exec(workflow)?.[1],
  );
  assert.ok(shards > 0, 'ci.yml sets KRN_TEST_SHARD_TOTAL');
  // Unweighted files count at the weight the sharder gives them, so a new
  // test file that overflows the shards fails here, not on main.
  const total = files.reduce(
    (sum, file) => sum + fileWeight(file, statSync(`${root}/${file}`).size),
    0,
  );
  const perShard = Math.round((total / shards) * 10) / 10;
  assert.ok(
    perShard <= MAX_SHARD_WEIGHT_SECONDS,
    `${total.toFixed(1)} s of weights on ${shards} shards is ${perShard} s per shard, over ${MAX_SHARD_WEIGHT_SECONDS} s; add a shard to the test matrix in .github/workflows/ci.yml`,
  );
});
