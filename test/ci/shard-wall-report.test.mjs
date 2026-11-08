import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TEST_FILE_WEIGHTS } from '../../scripts/lib/shard-weights.mjs';
import {
  filesOverBound,
  gitIsAncestor,
  parseArgs,
  pearson,
  predictShardWall,
  renderReport,
  resolveSince,
  runsSince,
  shardWallReport,
  sinceSelector,
  UsageError,
  weightDrift,
} from '../../scripts/shard-wall-report.mjs';
import {
  fetchShardRuns,
  foldShardWeights,
  runDurations,
} from '../../scripts/shard-weights-refresh.mjs';

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

// One `Test (k/N)` job as fetchShardRuns returns it; `durationMs` picks each
// file's CI duration.
const job = (name, seconds, files, durationMs = () => 1000) => ({
  name,
  seconds,
  summary: {
    files: files.map((file) => ({
      file: `/home/runner/work/krn/krn/${file}`,
      durationMs: durationMs(file),
    })),
  },
});

test('report pairs CI step seconds with predictions and gates the slowest p50', () => {
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
  // Every run's Test (3/3) came back untimed, as GitHub returns a job with
  // `steps: []`: the window says so, a FAIL stands and a PASS cannot.
  assert.match(rendered, /^runs: 3 of 3 wanted, 3 of 9 Test steps untimed$/mu);
  assert.match(rendered, /slowest Test step p50: 21 s, target < 18 s: FAIL/u);
  assert.match(
    renderReport({ ...report, slowestP50: 17 }),
    /slowest Test step p50: 17 s, target < 18 s: INCOMPLETE/u,
  );
  const timed = { ...report.window, untimed: 0 };
  const passed = renderReport({ ...report, slowestP50: 17, window: timed });
  assert.match(passed, /slowest Test step p50: 17 s, target < 18 s: PASS/u);
  assert.match(passed, /^runs: 3 of 3 wanted$/mu);
});

// A 10-shard fixture window of three runs: jobs arrive in reverse order, so
// 10/10 must sort after 9/10; shard 2 and 10 lose one step each, so their
// medians come from an even count; shard 3 carries the overload.
test('one shard p50 line names every shard median and the highest excess over their mean', () => {
  const steps = {
    1: [12, 10, 11],
    2: [10, 11, undefined],
    3: [14, 18, 18],
    10: [13, 14, undefined],
  };
  const runs = ['1', '2', '3'].map((id, index) => ({
    id,
    jobs: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((shard) =>
      job(`Test (${shard}/10)`, shard in steps ? steps[shard][index] : 11, []),
    ),
  }));
  const report = shardWallReport(runs, 4);
  assert.deepEqual(report.shardP50, {
    shards: [
      { shard: '1/10', p50: 11 },
      { shard: '2/10', p50: 10.5 },
      { shard: '3/10', p50: 18 },
      ...[4, 5, 6, 7, 8, 9].map((shard) => ({ shard: `${shard}/10`, p50: 11 })),
      { shard: '10/10', p50: 13.5 },
    ],
    mean: 11.9,
    highest: { shard: '3/10', p50: 18, excess: 6.1 },
  });
  const lines = renderReport(report)
    .split('\n')
    .filter((line) => line.startsWith('shard p50'));
  assert.deepEqual(lines, [
    'shard p50: 1/10=11 2/10=10.5 3/10=18 4/10=11 5/10=11 6/10=11 7/10=11 8/10=11 9/10=11 10/10=13.5 s; highest 3/10 +6.1 s over the mean 11.9 s',
  ]);

  const unmeasured = [{ id: '1', jobs: [job('Test (1/1)', undefined, [])] }];
  assert.match(
    renderReport(shardWallReport(unmeasured, 4)),
    /^shard p50: n\/a$/mu,
  );
});

const fixture = (name) =>
  readFileSync(
    fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)),
    'utf8',
  );

// Captured with `gh run list --repo krn-works/krn --workflow ci.yml --branch
// main --event push --status success --limit 4 --json databaseId,headSha`.
const listing = fixture('gh-run-list-main.json');
const listed = JSON.parse(listing);

test('the since filter keeps runs whose head is the commit or descends from it', () => {
  const asked = [];
  const descendants = new Set(listed.slice(0, 3).map((run) => run.headSha));
  const kept = runsSince(listed, 'base', (since, head) => {
    asked.push([since, head]);
    return descendants.has(head);
  });
  assert.deepEqual(kept, listed.slice(0, 3));
  // git merge-base --is-ancestor takes the older commit first.
  assert.deepEqual(
    asked,
    listed.map((run) => ['base', run.headSha]),
  );
  assert.deepEqual(
    runsSince(listed, 'base', () => false),
    [],
  );
});

test('the window applies before the newest runs are taken, and each run keeps its head', () => {
  const summary = {
    files: [
      {
        file: '/home/runner/work/krn/krn/test/a.test.ts',
        durationMs: 1000,
      },
    ],
  };
  const calls = [];
  const runGh = (args) => {
    calls.push(args);
    if (args[0] === 'run') return listing;
    if (args.at(-1).includes('/jobs?'))
      return JSON.stringify({
        jobs: [
          { id: 7, name: 'Test (1/1)', steps: [] },
          { id: 8, name: 'Lint', steps: [] },
        ],
      });
    return `2026-11-08T00:00:00.0000000Z KRN_TEST_SUMMARY_JSON=${JSON.stringify(summary)}\n`;
  };
  // The two newest heads are outside the window: wanting two runs still finds
  // the two inside it instead of filtering the newest two down to none.
  const inside = new Set(listed.slice(2).map((run) => run.headSha));
  const runs = fetchShardRuns('o/r', 2, {
    select: (all) => runsSince(all, 'base', (_, head) => inside.has(head)),
    runGh,
  });
  assert.deepEqual(
    runs.map((run) => [run.id, run.headSha]),
    listed.slice(2).map((run) => [String(run.databaseId), run.headSha]),
  );
  assert.ok(calls[0].includes('databaseId,headSha'));
  assert.equal(runs[0].jobs.length, 1);
});

// Weights are seconds and durationMs is milliseconds: steady runs 2000 ms
// against a weight of 2, so a unit mix-up would flag it.
const weights = {
  'test/slow.test.ts': 2,
  'test/steady.test.ts': 2,
  'test/edge.test.ts': 10,
  'test/over.test.ts': 10,
  'test/near.test.ts': 0.1,
  'test/tiny.test.ts': 0.1,
};
const jobWith = (name, durations) =>
  job(name, 10, Object.keys(durations), (file) => durations[file]);
const driftRuns = [
  [4000, 20, 140],
  [4200, 30, 142],
  [9000, 40, 144],
].map(([slow, tiny, near], index) => ({
  id: String(index + 1),
  jobs: [
    jobWith('Test (1/2)', {
      'test/slow.test.ts': slow,
      'test/steady.test.ts': 2000,
      'test/edge.test.ts': 13000,
    }),
    jobWith('Test (2/2)', {
      'test/over.test.ts': 13100,
      'test/near.test.ts': near,
      'test/tiny.test.ts': tiny,
      'test/gone.test.ts': 12000,
    }),
  ],
}));

test('drift lists files whose CI median exceeds the weight by more than 30%', () => {
  // slow: median 4.2 s of 4/4.2/9 against 2 s. over: 13.1 s against 10 s;
  // edge sits at exactly +30% and is not over. gone has no weight; tiny and
  // near are 30 ms and 142 ms, which weigh as the 0.1 s floor.
  assert.deepEqual(weightDrift(driftRuns, weights), [
    { file: 'test/over.test.ts', median: 13.1, weight: 10 },
    { file: 'test/slow.test.ts', median: 4.2, weight: 2 },
  ]);
});

test('files whose CI median exceeds the file bound are listed longest first', () => {
  // over (13.1 s) and edge (13 s) exceed 11 s whatever their weight; gone
  // runs 12 s but has no weight, so it is not in the plan.
  const over = filesOverBound(driftRuns, weights);
  assert.deepEqual(over, [
    { file: 'test/over.test.ts', median: 13.1 },
    { file: 'test/edge.test.ts', median: 13 },
  ]);
  assert.match(
    renderReport({ ...shardWallReport([], 4), overBound: over }),
    /^files over the 11 s bound: test\/over\.test\.ts 13\.1 s, test\/edge\.test\.ts 13 s$/mu,
  );
});

test('a weight folded from the runs never drifts against them', () => {
  const durations = driftRuns.map((run) =>
    runDurations(run.jobs.map((entry) => entry.summary)),
  );
  const files = [...new Set(durations.flatMap((run) => [...run.keys()]))];
  const { weights: folded } = foldShardWeights(durations, files);
  assert.equal(folded['test/near.test.ts'], 0.1);
  assert.deepEqual(weightDrift(driftRuns, folded), []);
});

test('the report prints the run window and either the drifting files or drift: none', () => {
  const at = (file, durationMs) => (name) =>
    name === file ? durationMs : Math.round(TEST_FILE_WEIGHTS[name] * 1000);
  const runsWith = (durationMs) =>
    ['1', '2'].map((id) => ({
      id,
      jobs: [job('Test (1/1)', 10, [heavy, light[0]], durationMs)],
    }));
  const steady = renderReport(
    shardWallReport(runsWith(at()), 4, { wanted: 5, since: '2194438' }),
  );
  assert.match(steady, /^runs: 2 of 5 wanted since 2194438$/mu);
  assert.match(steady, /^drift: none$/mu);
  assert.match(steady, /^files over the 11 s bound: none$/mu);
  assert.doesNotMatch(steady, /^file median_s/mu);

  const drifted = renderReport(
    shardWallReport(runsWith(at(light[0], 5000)), 4),
  );
  assert.match(drifted, /^drift: 1 file over weight by more than 30%$/mu);
  assert.match(drifted, /^file median_s weight_s over$/mu);
  const row = drifted.split('\n').find((line) => line.startsWith(light[0]));
  assert.equal(
    row.split(' ').slice(0, 3).join(' '),
    `${light[0]} 5 ${TEST_FILE_WEIGHTS[light[0]]}`,
  );
  assert.match(row, / \+\d+%$/u);
});

test('arguments name the window and malformed ones are usage errors', () => {
  const defaults = {
    wanted: 5,
    repo: 'krn-works/krn',
    lanes: 4,
    since: undefined,
  };
  assert.deepEqual(parseArgs([]), defaults);
  assert.deepEqual(parseArgs(['--since', '2194438', '--runs', '3']), {
    ...defaults,
    wanted: 3,
    since: '2194438',
  });
  for (const bad of [
    ['--since'],
    ['--since', 'main'],
    ['--since', 'zzzz'],
    ['--runs', '0'],
    ['--lanes', 'x'],
    ['--nope'],
  ])
    assert.throws(() => parseArgs(bad), UsageError, bad.join(' '));
});

// A git receiver answering from a script of [status, stdout, stderr].
function scriptedGit(replies) {
  const calls = [];
  const git = (args) => {
    calls.push(args[0]);
    const [status, stdout = '', stderr = ''] = replies.shift();
    return { status, stdout, stderr };
  };
  return { git, calls };
}

test('since resolves locally, fetches origin main once when missing, and rejects an unknown commit', () => {
  const known = scriptedGit([[0, 'abc123\n']]);
  assert.equal(resolveSince('abc1', known.git), 'abc123');
  assert.deepEqual(known.calls, ['rev-parse']);

  const missing = scriptedGit([[1], [0], [0, 'abc123\n']]);
  assert.equal(resolveSince('abc1', missing.git), 'abc123');
  assert.deepEqual(missing.calls, ['rev-parse', 'fetch', 'rev-parse']);

  const unknown = scriptedGit([[1], [0], [1]]);
  assert.throws(
    () => resolveSince('deadbeef', unknown.git),
    (error) =>
      error instanceof UsageError &&
      /unknown commit deadbeef/u.test(error.message),
  );

  const offline = scriptedGit([
    [1],
    [128, '', 'fatal: unable to access\nmore'],
  ]);
  assert.throws(
    () => resolveSince('deadbeef', offline.git),
    (error) =>
      !(error instanceof UsageError) &&
      /git fetch origin main failed: fatal: unable to access$/u.test(
        error.message,
      ),
  );
});

test('against real git: ancestry, fetch on demand, and exit 64 for an unknown commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wall-since-'));
  try {
    const run = (cwd, ...args) => {
      const result = spawnSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
        { cwd, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const origin = join(dir, 'origin.git');
    const work = join(dir, 'work');
    const clone = join(dir, 'clone');
    run(dir, 'init', '-q', '--bare', '-b', 'main', origin);
    run(dir, 'init', '-q', '-b', 'main', work);
    run(work, 'remote', 'add', 'origin', origin);
    const commit = (message) => {
      run(work, 'commit', '-q', '--allow-empty', '-m', message);
      run(work, 'push', '-q', 'origin', 'main');
      return run(work, 'rev-parse', 'HEAD');
    };
    const first = commit('first');
    const second = commit('second');
    run(dir, 'clone', '-q', origin, clone);
    // The clone stops here: later commits exist only on origin.
    const third = commit('third');
    const git = (args) =>
      spawnSync('git', args, { cwd: clone, encoding: 'utf8' });

    assert.equal(gitIsAncestor(first, second, git), true);
    assert.equal(gitIsAncestor(second, first, git), false);
    assert.equal(gitIsAncestor(second, second, git), true);
    assert.throws(
      () => gitIsAncestor(first, third, git),
      /git merge-base --is-ancestor .* failed: fatal/u,
    );

    assert.equal(resolveSince(first.slice(0, 8), git), first);
    assert.equal(resolveSince(third, git), third);
    assert.throws(
      () => resolveSince('deadbeef', git),
      (error) =>
        error instanceof UsageError && error.message.includes('deadbeef'),
    );

    const fourth = commit('fourth');
    const heads = [fourth, third, second, first].map((sha, index) => ({
      databaseId: 4 - index,
      headSha: sha,
    }));
    // fourth is unknown to the clone: selecting fetches it, then keeps the
    // runs at or after the since commit.
    assert.deepEqual(
      sinceSelector(second, git)(heads).map((entry) => entry.databaseId),
      [4, 3, 2],
    );

    const cli = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL('../../scripts/shard-wall-report.mjs', import.meta.url),
        ),
        '--since',
        'deadbeef',
      ],
      { cwd: clone, encoding: 'utf8' },
    );
    assert.equal(cli.status, 64);
    assert.match(cli.stderr, /^shard-wall: unknown commit deadbeef/u);
    assert.equal(cli.stdout, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
