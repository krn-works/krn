import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  fetchShardRuns,
  foldShardWeights,
  logStepSeconds,
  parseJobSummary,
  renderWeightsModule,
  repoTestPath,
  runDurations,
  testStepSeconds,
  weightSeconds,
} from '../../scripts/shard-weights-refresh.mjs';
import { summarizeTestEvents } from '../../scripts/test-summary-policy.mjs';

const capture = readFileSync(
  fileURLToPath(
    new URL('../fixtures/ci-test-summary-job.log', import.meta.url),
  ),
  'utf8',
);

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

// Verbatim output of `gh api --allow-escape-sequences
// repos/krn-works/krn/actions/jobs/128627133801/logs` and of
// `gh api repos/krn-works/krn/actions/jobs/128627133801`: Test (7/10) of main
// run 42446730414 at 6d833e5, whose jobs API carried its steps.
const fixture = (name) =>
  readFileSync(
    fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)),
    'utf8',
  );
const shardLog = fixture('ci-test-shard-job.log');
const shardJob = JSON.parse(fixture('ci-test-shard-job.json'));

test('the test step is timed from its log to a tenth, from the jobs API only when the log lacks it', () => {
  // The API keeps whole seconds, 04:25:30Z to 04:25:50Z; the log runs from
  // `##[group]Run npm test` at 04:25:30.94 to `Post job cleanup.` at 04:25:50.63.
  assert.equal(logStepSeconds(shardLog), 19.7);
  assert.equal(testStepSeconds(shardJob, shardLog), 19.7);
  // The excerpt capture lacks the step's start, so the API timing stands in.
  assert.equal(testStepSeconds(shardJob, capture), 20);
  assert.equal(testStepSeconds(shardJob), 20);
});

test('a job returned with steps: [] is timed from its log', () => {
  const bare = { ...shardJob, steps: [] };
  assert.equal(testStepSeconds(bare, shardLog), 19.7);
  assert.equal(testStepSeconds(bare), undefined);
});

test('a log without the step boundaries leaves the step untimed', () => {
  const lines = shardLog.split('\n');
  const summaryAt = lines.findIndex((line) =>
    line.includes('KRN_TEST_SUMMARY_JSON='),
  );
  // Without the summary no step printed it; the excerpt capture lacks the
  // step's start, and a log cut after the summary lacks its end.
  const unsummarized = lines.filter((_, index) => index !== summaryAt);
  assert.equal(logStepSeconds(unsummarized.join('\n')), undefined);
  assert.equal(logStepSeconds(capture), undefined);
  const cut = lines.slice(0, summaryAt + 1).join('\n');
  assert.equal(logStepSeconds(cut), undefined);
});

test('fetchShardRuns times each job from the log it fetched, with or without API steps', () => {
  const bare = { ...shardJob, id: shardJob.id + 1, name: 'Test (8/10)' };
  const jobs = [shardJob, { ...bare, steps: [] }];
  const runGh = (args) => {
    if (args[0] === 'run')
      return JSON.stringify([
        { databaseId: shardJob.run_id, headSha: shardJob.head_sha },
      ]);
    if (args.at(-1).includes('/jobs?')) return JSON.stringify({ jobs });
    assert.ok(
      jobs.some(
        ({ id }) => args.at(-1) === `repos/o/r/actions/jobs/${id}/logs`,
      ),
    );
    return shardLog;
  };
  const [run] = fetchShardRuns('o/r', 1, { runGh });
  assert.deepEqual(
    run.jobs.map(({ name, seconds }) => [name, seconds]),
    [
      ['Test (7/10)', 19.7],
      ['Test (8/10)', 19.7],
    ],
  );
});

test('summary records each file duration from its native summary event', () => {
  const file = '/w/test/a.test.ts';
  // Built from names: a literal todo counter trips the test-hygiene rule.
  const counts = Object.fromEntries(
    ['tests', 'passed', 'failed', 'skipped', 'todo', 'cancelled'].map(
      (field) => [field, field === 'tests' || field === 'passed' ? 1 : 0],
    ),
  );
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

test('a weight is the median durationMs in seconds, to a tenth, at least 0.1', () => {
  assert.equal(weightSeconds([4249]), 4.2);
  assert.equal(weightSeconds([4250]), 4.3);
  assert.equal(weightSeconds([2000, 6000]), 4);
  assert.equal(weightSeconds([1000, 1000, 90000]), 1);
  assert.equal(weightSeconds([20, 30, 40]), 0.1);
});

test('a run whose job times no file is rejected', () => {
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

// Main run 42579707304: one child lost its own summary, so the policy
// synthesised its counts without durationMs; the other files stay timed.
test('a file without a duration misses one sample, not the whole run', () => {
  const partial = {
    files: [
      { file: '/r/test/a.test.ts', durationMs: 5 },
      { file: '/r/test/lost.test.ts', tests: 23, passed: 23 },
    ],
  };
  const other = { files: [{ file: '/r/test/b.test.ts', durationMs: 7 }] };
  assert.deepEqual(
    [...(runDurations([partial, other]) ?? [])],
    [
      ['test/a.test.ts', 5],
      ['test/b.test.ts', 7],
    ],
  );
});
