// Shard wall report: does the shard plan predict CI shard wall time?
//   node scripts/shard-wall-report.mjs [--runs 5] [--since <sha>] [--repo owner/name] [--lanes 4]
// For each `Test (k/N)` job of the newest successful main runs it prints the
// actual `Run test shard` step seconds (to a tenth from the job log, whole
// seconds from the jobs API only when the log lacks the step) next to two
// predictions from the current weights: the summed shard weight, and the
// heaviest of the `--lanes` local lanes test-suite.mjs runs in parallel on the
// runner (plus final serial files). It ends with each model's Pearson r, the
// slowest-shard p50, one
// `shard p50` line (every shard's median Test step and the highest median's
// excess over the mean of the shard medians), one line of the test files whose
// median CI duration exceeds the file bound, and a drift section: every test
// file whose median CI duration over those runs exceeds its weight by more
// than 30% (`drift: none` when no file does).
// `--since <sha>` keeps only runs whose head is <sha> or descends from it, so
// a window holds one shard plan only until the next plan merges (judge it
// before then: `, decided` below says when); the first line, for example
// `runs: 2 of 5 wanted since 2194438`, shows a window that is still short,
// and ends with `, 3 of 50 Test steps untimed` when a Test step has timing in
// neither the jobs API (GitHub sometimes returns `steps: []`) nor its job log;
// such a window never prints PASS. While a window is short, the slowest-step
// verdict ends `, decided` once the missing runs cannot change it and
// `, provisional` while they can.
// It needs a checkout of the repository and fetches origin main once when a
// commit is missing locally. Exit 64 for a usage error (an unknown <sha>
// included), 1 for any other failure. Fetching needs an authenticated `gh`;
// the analysis is pure.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TEST_FILE_WEIGHTS } from './lib/shard-weights.mjs';
import { planTestShards } from './lib/test-shards.mjs';
import {
  fetchShardRuns,
  repoTestPath,
  weightSeconds,
} from './shard-weights-refresh.mjs';

export const STRONG_CORRELATION = 0.7;
export const SLOWEST_SHARD_TARGET_SECONDS = 18;
export const DRIFT_TOLERANCE = 0.3;
// The heaviest test file bounds its CI shard wall: a runner splits a shard's
// files across 4 local lanes, so one file heavier than the lane average sets
// the shard time whatever the plan sums. Files above it are split; the rule
// test holds weights to it, and this report holds CI medians to it, because
// weights lag a re-plan (one file rose from weight 10.1 to a 15.5 s median).
export const MAX_TEST_FILE_SECONDS = 11;
// Summed weight per CI shard at which the slowest Test step passed its 18 s
// target: the 7866a48 window ran 426.7 s of weights on 10 shards (42.7 s
// each) at a 15.5 s p50, while 498.9 s on 10 shards (49.9 s each) ran at
// 22 s. Above it the mean shard reaches the target and no rebalance passes,
// so the rule test asks for another shard in .github/workflows/ci.yml.
export const MAX_SHARD_WEIGHT_SECONDS = 43;

export class UsageError extends Error {}

const weightOf = (file) => TEST_FILE_WEIGHTS[file] ?? 1;

// Predicted shard wall: the heaviest local lane plus the serial files that run
// after the lanes, as test-suite.mjs schedules them on a `lanes`-core runner.
export function predictShardWall(files, lanes) {
  const plan = planTestShards(files, lanes);
  const heaviestLane = Math.max(0, ...plan.weights);
  const serial = plan.serialFiles.reduce(
    (sum, file) => sum + weightOf(file),
    0,
  );
  return heaviestLane + serial;
}

export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return Number.NaN;
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / n;
  const mx = mean(xs);
  const my = mean(ys);
  let covariance = 0;
  let vx = 0;
  let vy = 0;
  for (let index = 0; index < n; index += 1) {
    covariance += (xs[index] - mx) * (ys[index] - my);
    vx += (xs[index] - mx) ** 2;
    vy += (ys[index] - my) ** 2;
  }
  return covariance / Math.sqrt(vx * vy);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

const round = (value) => Math.round(value * 10) / 10;

// Runs whose head is `since` or descends from it, newest first as listed.
// `isAncestor(since, head)` is injected: git in main(), a stub in tests.
export function runsSince(listed, since, isAncestor) {
  return listed.filter((run) => isAncestor(since, run.headSha));
}

// Each planned test file's CI median over the runs, as [file, seconds, weight].
// Weights are seconds and `durationMs` is milliseconds, so the median is taken
// as a weight is (weightSeconds): a weight folded from these runs never drifts
// against them. A file without a weight is not in the plan, so it is skipped.
function fileMedians(runs, weights) {
  const samples = new Map();
  for (const run of runs)
    for (const job of run.jobs)
      for (const { file, durationMs } of job.summary.files) {
        const path = repoTestPath(file);
        if (!samples.has(path)) samples.set(path, []);
        samples.get(path).push(durationMs);
      }
  return [...samples]
    .filter(([file]) => weights[file] !== undefined)
    .map(([file, durations]) => [
      file,
      weightSeconds(durations),
      weights[file],
    ]);
}

// Test files whose CI median exceeds their weight by more than
// DRIFT_TOLERANCE, largest excess in seconds first.
export function weightDrift(runs, weights = TEST_FILE_WEIGHTS) {
  const drift = fileMedians(runs, weights)
    .filter(([, median, weight]) => median > weight * (1 + DRIFT_TOLERANCE))
    .map(([file, median, weight]) => ({ file, median, weight }));
  const excess = (row) => round(row.median - row.weight);
  return drift.sort(
    (a, b) => excess(b) - excess(a) || a.file.localeCompare(b.file),
  );
}

// Test files whose CI median exceeds MAX_TEST_FILE_SECONDS, longest first:
// each one sets its shard's wall, so it is the next file to split.
export function filesOverBound(runs, weights = TEST_FILE_WEIGHTS) {
  return fileMedians(runs, weights)
    .filter(([, median]) => median > MAX_TEST_FILE_SECONDS)
    .map(([file, median]) => ({ file, median }))
    .sort((a, b) => b.median - a.median || a.file.localeCompare(b.file));
}

// `Test (k/N)` is shard k of an N-shard plan; any other job name stays whole
// and sorts after the plans.
const SHARD_JOB = /^Test \((\d+)\/(\d+)\)$/u;
function shardOf(job) {
  const match = SHARD_JOB.exec(job);
  return match === null
    ? { shard: job, plan: Infinity, index: 0 }
    : {
        shard: `${match[1]}/${match[2]}`,
        plan: Number(match[2]),
        index: Number(match[1]),
      };
}

// Every shard's median Test step seconds over the window, in plan then shard
// order, and the highest median's excess over the mean of the shard medians,
// so an overloaded shard is named instead of read off the rows.
function shardP50(rows) {
  const samples = new Map();
  for (const { job, actual } of rows) {
    if (!samples.has(job)) samples.set(job, []);
    samples.get(job).push(actual);
  }
  const shards = [...samples]
    .map(([job, seconds]) => ({ ...shardOf(job), p50: round(median(seconds)) }))
    .sort(
      (a, b) =>
        a.plan - b.plan || a.index - b.index || a.shard.localeCompare(b.shard),
    )
    .map(({ shard, p50 }) => ({ shard, p50 }));
  if (shards.length === 0) return { shards };
  const mean = round(
    shards.reduce((sum, { p50 }) => sum + p50, 0) / shards.length,
  );
  const highest = shards.reduce((top, entry) =>
    entry.p50 > top.p50 ? entry : top,
  );
  return {
    shards,
    mean,
    highest: { ...highest, excess: round(highest.p50 - mean) },
  };
}

// runs: [{ id, jobs: [{ name, seconds, summary }] }] as fetchShardRuns returns;
// `wanted` and `since` only label the window the runs were drawn from.
export function shardWallReport(
  runs,
  lanes,
  { wanted = runs.length, since } = {},
) {
  const rows = [];
  let steps = 0;
  let untimed = 0;
  for (const run of runs)
    for (const job of run.jobs) {
      steps += 1;
      if (job.seconds === undefined) {
        untimed += 1;
        continue;
      }
      const files = job.summary.files.map((entry) => repoTestPath(entry.file));
      rows.push({
        run: run.id,
        job: job.name,
        actual: job.seconds,
        summed: round(files.reduce((sum, file) => sum + weightOf(file), 0)),
        predicted: round(predictShardWall(files, lanes)),
      });
    }
  const actual = rows.map((row) => row.actual);
  // Each run's slowest timed Test step; a run with no timed step has none.
  const slowest = runs
    .map((run) =>
      Math.max(
        ...run.jobs.map((job) => job.seconds).filter((s) => s !== undefined),
      ),
    )
    .filter(Number.isFinite);
  return {
    window: { used: runs.length, wanted, since, steps, untimed },
    rows,
    summedR: pearson(
      actual,
      rows.map((row) => row.summed),
    ),
    laneR: pearson(
      actual,
      rows.map((row) => row.predicted),
    ),
    slowest,
    // To a hundredth: the median of two tenths can end in 5, and a tenth
    // would round 17.95 s across the 18 s target.
    slowestP50:
      slowest.length > 0 ? Math.round(median(slowest) * 100) / 100 : Number.NaN,
    shardP50: shardP50(rows),
    overBound: filesOverBound(runs),
    drift: weightDrift(runs),
  };
}

// How many runs the report used against how many were wanted, so a window
// that is still short is visible, and how many Test steps neither the jobs API
// nor the job log timed, whose samples every step verdict lacks.
export function windowLine({ used, wanted, since, steps, untimed = 0 }) {
  const window = `runs: ${used} of ${wanted} wanted${since === undefined ? '' : ` since ${since}`}`;
  return untimed > 0
    ? `${window}, ${untimed} of ${steps} Test steps untimed`
    : window;
}

// An untimed step can only hide a slower one, so it blocks a PASS, not a FAIL.
function targetVerdict({ slowestP50, window }) {
  if (slowestP50 >= SLOWEST_SHARD_TARGET_SECONDS) return 'FAIL';
  return Number.isNaN(slowestP50) || window.untimed > 0 ? 'INCOMPLETE' : 'PASS';
}

// A window short of `wanted` runs is decided once more than half of `wanted`
// slowest steps sit on one side of the target: the missing runs cannot move
// the median of `wanted` across it. An untimed step can hide a slower one, so
// it leaves only the FAIL side to decide.
function slowestVerdict(report) {
  const { slowest, window } = report;
  const verdict = targetVerdict(report);
  if (window.used >= window.wanted) return verdict;
  const over = slowest.filter(
    (seconds) => seconds >= SLOWEST_SHARD_TARGET_SECONDS,
  ).length;
  const under = window.untimed > 0 ? 0 : slowest.length - over;
  const decided = Math.max(over, under) > window.wanted / 2;
  return `${verdict}, ${decided ? 'decided' : 'provisional'}`;
}

function driftLines(drift) {
  if (drift.length === 0) return ['drift: none'];
  const percent = Math.round(DRIFT_TOLERANCE * 100);
  return [
    `drift: ${drift.length} ${drift.length === 1 ? 'file' : 'files'} over weight by more than ${percent}%`,
    'file median_s weight_s over',
    ...drift.map(
      ({ file, median, weight }) =>
        `${file} ${median} ${weight} +${Math.round((median / weight - 1) * 100)}%`,
    ),
  ];
}

function overBoundLine(files) {
  const listed = files.map(({ file, median }) => `${file} ${median} s`);
  return `files over the ${MAX_TEST_FILE_SECONDS} s bound: ${listed.length === 0 ? 'none' : listed.join(', ')}`;
}

function shardP50Line({ shards, mean, highest }) {
  if (shards.length === 0) return 'shard p50: n/a';
  const medians = shards.map(({ shard, p50 }) => `${shard}=${p50}`).join(' ');
  return `shard p50: ${medians} s; highest ${highest.shard} +${highest.excess} s over the mean ${mean} s`;
}

export function renderReport(report) {
  const lines = [
    windowLine(report.window),
    'run job actual_s summed_weight predicted_wall',
  ];
  for (const row of report.rows)
    lines.push(
      `${row.run} ${row.job} ${row.actual} ${row.summed} ${row.predicted}`,
    );
  const verdict = (r) =>
    r >= STRONG_CORRELATION ? 'strong' : Number.isNaN(r) ? 'n/a' : 'weak';
  lines.push(
    `summed-weight model: r=${report.summedR.toFixed(2)} (${verdict(report.summedR)})`,
    `heaviest-lane model: r=${report.laneR.toFixed(2)} (${verdict(report.laneR)})`,
    `slowest Test step p50: ${report.slowestP50} s, target < ${SLOWEST_SHARD_TARGET_SECONDS} s: ${slowestVerdict(report)}`,
    shardP50Line(report.shardP50),
    overBoundLine(report.overBound),
    ...driftLines(report.drift),
  );
  return `${lines.join('\n')}\n`;
}

const SHA = /^[0-9a-f]{4,40}$/iu;

export function parseArgs(argv) {
  const options = {
    wanted: 5,
    repo: 'krn-works/krn',
    lanes: 4,
    since: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) throw new UsageError(`${arg} needs a value`);
      return argv[index];
    };
    if (arg === '--runs') options.wanted = Number(value());
    else if (arg === '--repo') options.repo = value();
    else if (arg === '--lanes') options.lanes = Number(value());
    else if (arg === '--since') options.since = value();
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  if (!Number.isSafeInteger(options.wanted) || options.wanted < 1)
    throw new UsageError('--runs must be a positive integer');
  if (!Number.isSafeInteger(options.lanes) || options.lanes < 1)
    throw new UsageError('--lanes must be a positive integer');
  if (options.since !== undefined && !SHA.test(options.since))
    throw new UsageError(
      `--since needs a commit SHA of 4 to 40 hex digits, got ${options.since}`,
    );
  return options;
}

// `git(args)` is the git receiver: { status, stdout, stderr } as spawnSync.
// A fetch that needs credentials fails instead of prompting.
const spawnGit = (args) =>
  spawnSync('git', args, {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
const firstLine = (text) => String(text ?? '').split('\n')[0];

function fetchOriginMain(git) {
  const fetched = git(['fetch', '--quiet', 'origin', 'main']);
  if (fetched.status !== 0)
    throw new Error(
      `git fetch origin main failed: ${firstLine(fetched.stderr)}`,
    );
}

const hasCommit = (sha, git) =>
  git(['cat-file', '-e', `${sha}^{commit}`]).status === 0;

// The full SHA of `since`. A commit missing locally triggers one
// `git fetch origin main`; one still unknown after it is a usage error.
export function resolveSince(since, git) {
  const lookup = () =>
    git(['rev-parse', '--verify', '--quiet', `${since}^{commit}`]);
  let found = lookup();
  if (found.status !== 0) {
    fetchOriginMain(git);
    found = lookup();
  }
  if (found.status !== 0)
    throw new UsageError(
      `unknown commit ${since}: not in this checkout or on origin main`,
    );
  return found.stdout.trim();
}

// git answers by exit status: 0 ancestor (or the same commit), 1 not an
// ancestor, anything else an error such as an unknown commit.
export function gitIsAncestor(ancestor, head, git) {
  const { status, stderr } = git([
    'merge-base',
    '--is-ancestor',
    ancestor,
    head,
  ]);
  if (status === 0 || status === 1) return status === 0;
  throw new Error(
    `git merge-base --is-ancestor ${ancestor} ${head} failed: ${firstLine(stderr)}`,
  );
}

// The `select` hook of fetchShardRuns for a window starting at `base`. A run
// head newer than this checkout's origin/main needs one fetch to be ordered.
export function sinceSelector(base, git) {
  return (listed) => {
    if (listed.some((run) => !hasCommit(run.headSha, git)))
      fetchOriginMain(git);
    return runsSince(listed, base, (ancestor, head) =>
      gitIsAncestor(ancestor, head, git),
    );
  };
}

function main(argv) {
  const { wanted, repo, lanes, since } = parseArgs(argv);
  const select =
    since === undefined
      ? undefined
      : sinceSelector(resolveSince(since, spawnGit), spawnGit);
  const runs = fetchShardRuns(repo, wanted, { select });
  if (runs.length === 0) {
    process.stdout.write(`${windowLine({ used: 0, wanted, since })}\n`);
    throw new Error(
      `no main runs${since === undefined ? '' : ` since ${since}`} carry shard durations`,
    );
  }
  process.stdout.write(
    renderReport(shardWallReport(runs, lanes, { wanted, since })),
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`shard-wall: ${error.message}\n`);
    process.exitCode = error instanceof UsageError ? 64 : 1;
  }
}
