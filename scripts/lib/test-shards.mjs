import { statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import { summarizeTestEvents } from '../test-summary-policy.mjs';
import { TEST_FILE_WEIGHTS } from './shard-weights.mjs';

const COUNT_FIELDS = [
  'tests',
  'passed',
  'failed',
  'skipped',
  'todo',
  'cancelled',
];

export const SERIAL_TEST_REASONS = Object.freeze({
  'test/hosts/codex-stale-scope.test.ts':
    'asserts systemd scope teardown within the configured runtime grace plus 1.5 seconds',
});

export const SERIAL_TEST_FILES = Object.freeze(
  Object.keys(SERIAL_TEST_REASONS),
);

function zeroCounts() {
  return Object.fromEntries(COUNT_FIELDS.map((field) => [field, 0]));
}

function validCounts(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    COUNT_FIELDS.every(
      (field) => Number.isSafeInteger(value[field]) && value[field] >= 0,
    ) &&
    value.tests ===
      value.passed + value.failed + value.skipped + value.todo + value.cancelled
  );
}

function normalizedFile(file) {
  const path = isAbsolute(file) ? relative(process.cwd(), file) : file;
  return path.split(sep).join('/');
}

export function defaultTestShardCount(coreCount = availableParallelism()) {
  const cores =
    Number.isSafeInteger(coreCount) && coreCount > 0 ? coreCount : 1;
  return Math.max(1, Math.min(4, cores));
}

export function configuredTestShardCount(override, coreCount) {
  if (override === undefined)
    return defaultTestShardCount(coreCount ?? availableParallelism());
  if (typeof override !== 'string' || !/^[1-9]\d*$/u.test(override))
    throw new Error('KRN_TEST_SHARDS must be a positive integer');
  const count = Number(override);
  if (!Number.isSafeInteger(count))
    throw new Error('KRN_TEST_SHARDS must be a safe positive integer');
  return count;
}

const MEDIAN_WEIGHT = (() => {
  const sorted = Object.values(TEST_FILE_WEIGHTS).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 1;
})();

// Measured seconds when recorded; otherwise the file size ranks it among its
// unmeasured peers and the median keeps it commensurate with measured files.
function fileWeight(file, size) {
  const measured = TEST_FILE_WEIGHTS[normalizedFile(file)];
  return measured ?? (size > 0 ? Math.max(1, size / 4096) : MEDIAN_WEIGHT);
}

export function planTestShards(
  files,
  shardCount,
  serialFiles = SERIAL_TEST_FILES,
) {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1)
    throw new Error('test shard count must be a positive integer');
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string'))
    throw new Error('test shard plan requires a list of file paths');

  const selected = [...new Set(files)].sort();
  const serialNames = new Set(serialFiles.map(normalizedFile));
  const finalSerialFiles = selected.filter((file) =>
    serialNames.has(normalizedFile(file)),
  );
  const parallelFiles = selected
    .filter((file) => !serialNames.has(normalizedFile(file)))
    .map((file) => {
      try {
        const size = statSync(file).size;
        return { file, size: fileWeight(file, size) };
      } catch {
        return { file, size: fileWeight(file, 0) };
      }
    })
    .sort(
      (left, right) =>
        right.size - left.size || left.file.localeCompare(right.file),
    );
  const effectiveShards = Math.min(shardCount, parallelFiles.length);
  const shards = Array.from({ length: effectiveShards }, () => []);
  const shardWeights = Array.from({ length: effectiveShards }, () => 0);
  for (const { file, size } of parallelFiles) {
    let target = 0;
    for (let index = 1; index < effectiveShards; index += 1) {
      if (
        shardWeights[index] < shardWeights[target] ||
        (shardWeights[index] === shardWeights[target] &&
          shards[index].length < shards[target].length)
      )
        target = index;
    }
    shards[target].push(file);
    shardWeights[target] += size || 1;
  }

  return { shards, serialFiles: finalSerialFiles, weights: shardWeights };
}

export function configuredTestShardSelection(index, total) {
  if (index === undefined && total === undefined) return undefined;
  const positive = /^[1-9]\d{0,5}$/u;
  if (
    typeof index !== 'string' ||
    typeof total !== 'string' ||
    !positive.test(index) ||
    !positive.test(total)
  )
    throw new Error(
      'KRN_TEST_SHARD_INDEX and KRN_TEST_SHARD_TOTAL must both be positive integers',
    );
  const selection = { index: Number(index), total: Number(total) };
  if (selection.index > selection.total)
    throw new Error(
      'KRN_TEST_SHARD_INDEX must not exceed KRN_TEST_SHARD_TOTAL',
    );
  return selection;
}

// Splits the planned lanes across `total` runners deterministically: the
// size-balanced lanes of planTestShards are distributed one lane per runner
// and each serial file, heaviest first, to the runner with the least planned
// weight, so it never lengthens the heaviest lane and every file lands in
// exactly one selection. Shard `index` (1-based) returns its own files.
export function selectTestShardFiles(
  files,
  index,
  total,
  serialFiles = SERIAL_TEST_FILES,
) {
  if (!Number.isSafeInteger(total) || total < 1)
    throw new Error('test shard total must be a positive integer');
  if (!Number.isSafeInteger(index) || index < 1 || index > total)
    throw new Error('test shard index must be between 1 and the total');
  const plan = planTestShards(files, total, serialFiles);
  const selected = [...(plan.shards[index - 1] ?? [])];
  const load = Array.from(
    { length: total },
    (_, lane) => plan.weights[lane] ?? 0,
  );
  const serial = plan.serialFiles
    .map((file) => ({ file, weight: fileWeight(file, 0) }))
    .sort(
      (left, right) =>
        right.weight - left.weight || left.file.localeCompare(right.file),
    );
  for (const { file, weight } of serial) {
    let lightest = 0;
    for (let lane = 1; lane < total; lane += 1)
      if (load[lane] < load[lightest]) lightest = lane;
    load[lightest] += weight;
    if (lightest === index - 1) selected.push(file);
  }
  return selected.sort();
}

export function mergeTestShardResults(
  shardResults,
  expectedFiles,
  { expectedTestCount } = {},
) {
  const errors = [];
  const mergedEvents = [];
  const totals = zeroCounts();
  let allGlobalSummariesValid =
    Array.isArray(shardResults) && shardResults.length > 0;
  let allGlobalSummariesSuccessful = true;
  let runnerExitCode = 0;

  if (!Array.isArray(shardResults)) {
    errors.push('test shard results are not an array');
    shardResults = [];
    allGlobalSummariesValid = false;
  }

  for (const [index, result] of shardResults.entries()) {
    if (!result || typeof result !== 'object') {
      errors.push(`test shard result ${index} is malformed`);
      allGlobalSummariesValid = false;
      runnerExitCode = 1;
      continue;
    }
    if (result.runnerExitCode !== 0) runnerExitCode = 1;
    if (result.error) {
      errors.push(`test shard ${index + 1}: ${result.error}`);
      runnerExitCode = 1;
    }
    if (!Array.isArray(result.events)) {
      errors.push(`test shard ${index + 1} events are not an array`);
      allGlobalSummariesValid = false;
      runnerExitCode = 1;
      continue;
    }

    const globalSummaries = [];
    for (const event of result.events) {
      if (
        event?.type === 'test:summary' &&
        event.data &&
        typeof event.data === 'object' &&
        !Object.hasOwn(event.data, 'entryFile')
      ) {
        globalSummaries.push(event.data);
      } else {
        mergedEvents.push(event);
      }
    }
    if (globalSummaries.length !== 1) {
      errors.push(
        `test shard ${index + 1} must contain exactly one global summary`,
      );
      allGlobalSummariesValid = false;
      continue;
    }

    const global = globalSummaries[0];
    if (typeof global.success !== 'boolean' || !validCounts(global.counts)) {
      errors.push(`test shard ${index + 1} global summary is invalid`);
      allGlobalSummariesValid = false;
      continue;
    }
    allGlobalSummariesSuccessful &&= global.success;
    for (const field of COUNT_FIELDS) totals[field] += global.counts[field];
  }

  if (allGlobalSummariesValid) {
    mergedEvents.push({
      type: 'test:summary',
      data: { success: allGlobalSummariesSuccessful, counts: totals },
    });
  }

  const result = summarizeTestEvents(
    mergedEvents,
    expectedFiles,
    runnerExitCode,
  );
  errors.push(...result.errors);
  if (
    expectedTestCount !== undefined &&
    (!Number.isSafeInteger(expectedTestCount) || expectedTestCount < 0)
  ) {
    errors.push('native TAP test count is invalid');
  } else if (
    expectedTestCount !== undefined &&
    result.summary.counts.tests !== expectedTestCount
  ) {
    errors.push(
      `merged summary reports ${result.summary.counts.tests} tests; native TAP reports ${expectedTestCount}`,
    );
  }

  result.errors = [...new Set(errors)];
  result.ok = result.errors.length === 0;
  if (!result.ok) result.summary.success = false;
  return result;
}
