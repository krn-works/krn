import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TEST_FILE_WEIGHTS } from '../../scripts/lib/shard-weights.mjs';
import {
  foldShardWeights,
  parseJobSummary,
  renderWeightsModule,
  repoTestPath,
  runDurations,
} from '../../scripts/shard-weights-refresh.mjs';
import { selectTestFiles } from '../../scripts/test-suite.mjs';
import { summarizeTestEvents } from '../../scripts/test-summary-policy.mjs';

const root = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const capture = readFileSync(
  fileURLToPath(
    new URL('../fixtures/ci-test-summary-job.log', import.meta.url),
  ),
  'utf8',
);

test('every test file has a shard weight and every weight a test file', () => {
  const files = selectTestFiles([], root).map((file) =>
    relative(root, file).split(sep).join('/'),
  );
  const weighted = Object.keys(TEST_FILE_WEIGHTS);
  assert.deepEqual(
    files.filter((file) => !Object.hasOwn(TEST_FILE_WEIGHTS, file)),
    [],
    'run `node scripts/shard-weights-refresh.mjs --write` or add a weight',
  );
  assert.deepEqual(
    weighted.filter((file) => !files.includes(file)),
    [],
    'weights name deleted test files',
  );
});

test('a verbatim CI job log yields its summary with repository paths', () => {
  const summary = parseJobSummary(capture);
  assert.equal(summary.version, 1);
  assert.ok(summary.files.length > 0);
  for (const entry of summary.files)
    assert.match(repoTestPath(entry.file), /^test\/.+\.test\.ts$/u);
  // The capture predates durationMs, so the run is not usable.
  assert.equal(runDurations([summary]), undefined);
  assert.equal(parseJobSummary('no summary here\n'), undefined);
});

test('summary records each file duration from its native summary event', () => {
  const file = '/w/test/a.test.ts';
  const counts = {
    tests: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    todo: 0,
    cancelled: 0,
  };
  const { ok, summary } = summarizeTestEvents(
    [
      {
        type: 'test:pass',
        data: { entryFile: file, details: { type: 'test' } },
      },
      {
        type: 'test:summary',
        data: { entryFile: file, success: true, counts, duration_ms: 1234.6 },
      },
      { type: 'test:summary', data: { success: true, counts } },
    ],
    [file],
  );
  assert.equal(ok, true);
  assert.equal(summary.files[0].durationMs, 1235);
});

test('fold takes the per-file median across runs and keeps unmeasured files', () => {
  const runs = [
    new Map([
      ['test/a.test.ts', 1000],
      ['test/gone.test.ts', 5000],
    ]),
    new Map([['test/a.test.ts', 3000]]),
    new Map([['test/a.test.ts', 2400]]),
    new Map([['test/b.test.ts', 20]]),
  ];
  const { weights, unmeasured } = foldShardWeights(
    runs,
    ['test/c.test.ts', 'test/b.test.ts', 'test/a.test.ts', 'test/d.test.ts'],
    { 'test/c.test.ts': 7 },
  );
  assert.deepEqual(weights, {
    'test/a.test.ts': 2.4,
    'test/b.test.ts': 0.1,
    'test/c.test.ts': 7,
  });
  assert.deepEqual(unmeasured, ['test/c.test.ts', 'test/d.test.ts']);
});

test('a run missing any file duration is rejected', () => {
  const good = { files: [{ file: '/r/test/a.test.ts', durationMs: 5 }] };
  const bad = { files: [{ file: '/r/test/b.test.ts' }] };
  assert.deepEqual([...(runDurations([good]) ?? [])], [['test/a.test.ts', 5]]);
  assert.equal(runDurations([good, bad]), undefined);
  assert.equal(runDurations([good, undefined]), undefined);
  assert.equal(runDurations([]), undefined);
});

test('rendered module round-trips through import', async () => {
  const source = renderWeightsModule({ 'test/a.test.ts': 1.5 }, ['1', '2']);
  const module = await import(
    `data:text/javascript,${encodeURIComponent(source)}`
  );
  assert.deepEqual({ ...module.TEST_FILE_WEIGHTS }, { 'test/a.test.ts': 1.5 });
  assert.match(source, /runs\n\/\/ 1 2\./u);
});
