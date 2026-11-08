// Shard wall report: does the shard plan predict CI shard wall time?
//   node scripts/shard-wall-report.mjs [--runs 5] [--since <sha>] [--repo owner/name] [--lanes 4]
// For each `Test (k/N)` job of the newest successful main runs it prints the
// actual `Run test shard` step seconds next to two predictions from the
// current weights: the summed shard weight, and the heaviest of the `--lanes`
// local lanes test-suite.mjs runs in parallel on the runner (plus final serial
// files). It ends with each model's Pearson r, the slowest-shard p50, one
// `shard p50` line (every shard's median Test step and the highest median's
// excess over the mean of the shard medians) and a drift section: every test
// file whose median CI duration over those runs exceeds its weight by more
// than 30% (`drift: none` when no file does).
// `--since <sha>` keeps only runs whose head is <sha> or descends from it, so
// a window never mixes shard plans; the first line, for example
// `runs: 2 of 5 wanted since 2194438`, shows a window that is still short.
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
export const SLOWEST_SHARD_TARGET_SECONDS = 24;
export const DRIFT_TOLERANCE = 0.3;

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

// Test files whose CI median exceeds their weight by more than
// DRIFT_TOLERANCE, largest excess in seconds first. Weights are seconds and
// `durationMs` is milliseconds, so the median is taken as a weight is
// (weightSeconds): a weight folded from these runs never drifts against them.
// A file without a weight is not in the plan, so it is skipped.
export function weightDrift(runs, weights = TEST_FILE_WEIGHTS) {
  const samples = new Map();
  for (const run of runs)
    for (const job of run.jobs)
      for (const { file, durationMs } of job.summary.files) {
        const path = repoTestPath(file);
        if (!samples.has(path)) samples.set(path, []);
        samples.get(path).push(durationMs);
      }
  const drift = [];
  for (const [file, durations] of samples) {
    const weight = weights[file];
    if (weight === undefined) continue;
    const seconds = weightSeconds(durations);
    if (seconds > weight * (1 + DRIFT_TOLERANCE))
      drift.push({ file, median: seconds, weight });
  }
  const excess = (row) => round(row.median - row.weight);
  return drift.sort(
    (a, b) => excess(b) - excess(a) || a.file.localeCompare(b.file),
  );
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
  for (const run of runs)
    for (const job of run.jobs) {
      if (job.seconds === undefined) continue;
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
  const slowest = runs
    .map((run) =>
      Math.max(
        ...run.jobs.map((job) => job.seconds).filter((s) => s !== undefined),
      ),
    )
    .filter(Number.isFinite);
  return {
    window: { used: runs.length, wanted, since },
    rows,
    summedR: pearson(
      actual,
      rows.map((row) => row.summed),
    ),
    laneR: pearson(
      actual,
      rows.map((row) => row.predicted),
    ),
    slowestP50: slowest.length > 0 ? median(slowest) : Number.NaN,
    shardP50: shardP50(rows),
    drift: weightDrift(runs),
  };
}

// How many runs the report used against how many were wanted, so a window
// that is still short is visible.
export function windowLine({ used, wanted, since }) {
  return `runs: ${used} of ${wanted} wanted${since === undefined ? '' : ` since ${since}`}`;
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
    `slowest Test step p50: ${report.slowestP50} s, target < ${SLOWEST_SHARD_TARGET_SECONDS} s: ${report.slowestP50 < SLOWEST_SHARD_TARGET_SECONDS ? 'PASS' : 'FAIL'}`,
    shardP50Line(report.shardP50),
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
