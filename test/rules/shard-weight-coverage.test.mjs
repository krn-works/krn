import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TEST_FILE_WEIGHTS } from '../../scripts/lib/shard-weights.mjs';
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

// The heaviest test file bounds its CI shard wall: a runner splits its files
// across 4 local lanes, so one file heavier than the lane average sets the
// shard time (scripts/shard-wall-report.mjs, r=0.77 against r=-0.07 for the
// summed weight). Keep every file under the bound by splitting it. Weights are
// CI-measured (`node scripts/shard-weights-refresh.mjs --write`) under 4-lane
// contention, about 2x a local estimate, so a split's local-estimate weights
// must be refreshed from CI before they are trusted.
const MAX_TEST_FILE_SECONDS = 11;

test('no test file is heavy enough to bound its shard wall', () => {
  assert.deepEqual(
    Object.entries(TEST_FILE_WEIGHTS)
      .filter(([, seconds]) => seconds > MAX_TEST_FILE_SECONDS)
      .map(([file]) => file),
    [],
    `split test files above ${MAX_TEST_FILE_SECONDS} s so the slowest shard stays near that bound`,
  );
});
