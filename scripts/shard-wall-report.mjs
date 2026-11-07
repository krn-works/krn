// Shard wall report: does the shard plan predict CI shard wall time?
//   node scripts/shard-wall-report.mjs [--runs 5] [--repo owner/name] [--lanes 4]
// For each `Test (k/N)` job of the newest successful main runs it prints the
// actual `Run test shard` step seconds next to two predictions from the
// current weights: the summed shard weight, and the heaviest of the `--lanes`
// local lanes test-suite.mjs runs in parallel on the runner (plus final serial
// files). It ends with each model's Pearson r and the slowest-shard p50.
// Fetching needs an authenticated `gh`; the analysis is pure.
import { fileURLToPath } from 'node:url';
import { TEST_FILE_WEIGHTS } from './lib/shard-weights.mjs';
import { planTestShards } from './lib/test-shards.mjs';
import { fetchShardRuns, repoTestPath } from './shard-weights-refresh.mjs';

export const STRONG_CORRELATION = 0.7;
export const SLOWEST_SHARD_TARGET_SECONDS = 24;

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

// runs: [{ id, jobs: [{ name, seconds, summary }] }] as fetchShardRuns returns.
export function shardWallReport(runs, lanes) {
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
  };
}

export function renderReport(report) {
  const lines = ['run job actual_s summed_weight predicted_wall'];
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
  );
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  let wanted = 5;
  let repo = 'krn-works/krn';
  let lanes = 4;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--runs') wanted = Number(argv[++index]);
    else if (arg === '--repo') repo = argv[++index];
    else if (arg === '--lanes') lanes = Number(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isSafeInteger(wanted) || wanted < 1)
    throw new Error('--runs must be a positive integer');
  if (!Number.isSafeInteger(lanes) || lanes < 1)
    throw new Error('--lanes must be a positive integer');
  const runs = fetchShardRuns(repo, wanted);
  if (runs.length === 0) throw new Error('no main runs carry shard durations');
  process.stdout.write(renderReport(shardWallReport(runs, lanes)));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`shard-wall: ${error.message}\n`);
    process.exitCode = 1;
  }
}
