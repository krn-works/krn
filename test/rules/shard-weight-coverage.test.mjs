import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TEST_FILE_WEIGHTS } from '../../scripts/lib/shard-weights.mjs';
import { MAX_TEST_FILE_SECONDS } from '../../scripts/shard-wall-report.mjs';
import { selectTestFiles } from '../../scripts/test-suite.mjs';

// A rule test so `npm run fast` runs it whenever a test file is added or removed.
const root = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));

test('every test file has a shard weight and every weight a test file', () => {
  const files = selectTestFiles([], root).map((file) =>
    relative(root, file).split(sep).join('/'),
  );
  assert.deepEqual(
    files.filter((file) => !Object.hasOwn(TEST_FILE_WEIGHTS, file)),
    [],
    'add a weight in scripts/lib/shard-weights.mjs; the refresh script adds files only after CI samples exist',
  );
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
