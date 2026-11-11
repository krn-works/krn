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

function medianWeight(weights) {
  const sorted = Object.values(weights).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 1;
}

// Measured seconds when recorded; otherwise the file size ranks it among its
// unmeasured peers and the median keeps it commensurate with measured files.
export function fileWeight(file, size, weights = TEST_FILE_WEIGHTS) {
  const measured = weights[normalizedFile(file)];
  return (
    measured ?? (size > 0 ? Math.max(1, size / 4096) : medianWeight(weights))
  );
}

// A family is the files in one directory whose names share their first word,
// as a split keeps its parent's name: input-bounds-baseline and
// input-bounds-persisted are both `test/worker/input`.
export function testFileFamily(file) {
  const path = normalizedFile(file);
  const slash = path.lastIndexOf('/');
  return path.slice(0, slash + 1) + path.slice(slash + 1).split(/[-.]/u)[0];
}

// The directory of a test file: files in one directory exercise the same
// subsystem (test/task spawns git worktrees, test/worker spawns workers), so
// side by side on one runner they contend beyond their weights.
export function testFileDirectory(file) {
  const path = normalizedFile(file);
  return path.slice(0, path.lastIndexOf('/') + 1);
}

// Among the bins within this many seconds of the lightest, a file goes to the
// one holding the fewest files of its directory. Main runs since 79dd29e ran
// Test (3/12) slowest twice at 18.5-19 s with three test/task files whose CI
// seconds summed 20.7 against weights of 14; the spread caps them at 7.7.
export const DIRECTORY_SPREAD_SECONDS = 1;

// Each file goes to a bin holding the fewest files of its family, the lightest of
// those: same-family files load the same resource, and side by side in one
// CI runner they ran up to twice their apart median (input-bounds-baseline
// 17.4 s against 8.7 s in main runs since e79cb01).
export function planTestShards(files, shardCount, weights = TEST_FILE_WEIGHTS) {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1)
    throw new Error('test shard count must be a positive integer');
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string'))
    throw new Error('test shard plan requires a list of file paths');

  const selected = [...new Set(files)].sort();
  const parallelFiles = selected
    .map((file) => {
      try {
        const size = statSync(file).size;
        return { file, size: fileWeight(file, size, weights) };
      } catch {
        return { file, size: fileWeight(file, 0, weights) };
      }
    })
    .sort(
      (left, right) =>
        right.size - left.size || left.file.localeCompare(right.file),
    );
  const effectiveShards = Math.min(shardCount, parallelFiles.length);
  const shards = Array.from({ length: effectiveShards }, () => []);
  const shardWeights = Array.from({ length: effectiveShards }, () => 0);
  const families = Array.from({ length: effectiveShards }, () => new Map());
  const directories = Array.from({ length: effectiveShards }, () => new Map());
  for (const { file, size } of parallelFiles) {
    const family = testFileFamily(file);
    const directory = testFileDirectory(file);
    const kin = (index) => families[index].get(family) ?? 0;
    const neighbours = (index) => directories[index].get(directory) ?? 0;
    const bins = Array.from({ length: effectiveShards }, (_, index) => index);
    const fewestKin = Math.min(...bins.map(kin));
    const open = bins.filter((index) => kin(index) === fewestKin);
    const lightest = Math.min(...open.map((index) => shardWeights[index]));
    let target = -1;
    for (const index of open) {
      if (shardWeights[index] > lightest + DIRECTORY_SPREAD_SECONDS) continue;
      if (
        target === -1 ||
        neighbours(index) < neighbours(target) ||
        (neighbours(index) === neighbours(target) &&
          (shardWeights[index] < shardWeights[target] ||
            (shardWeights[index] === shardWeights[target] &&
              shards[index].length < shards[target].length)))
      )
        target = index;
    }
    shards[target].push(file);
    shardWeights[target] += size || 1;
    families[target].set(family, kin(target) + 1);
    directories[target].set(directory, neighbours(target) + 1);
  }

  return { shards, weights: shardWeights };
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

// Splits the files across `total` runners deterministically so every file
// lands in exactly one selection. Shard `index` (1-based) returns its own files.
export function selectTestShardFiles(files, index, total) {
  if (!Number.isSafeInteger(total) || total < 1)
    throw new Error('test shard total must be a positive integer');
  if (!Number.isSafeInteger(index) || index < 1 || index > total)
    throw new Error('test shard index must be between 1 and the total');
  const plan = planTestShards(files, total);
  return [...(plan.shards[index - 1] ?? [])].sort();
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
