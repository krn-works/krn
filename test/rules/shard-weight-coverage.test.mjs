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
