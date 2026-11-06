import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import { summarizeTestEvents } from '../test-summary-policy.mjs';

const COUNT_FIELDS = [
  'tests',
  'passed',
  'failed',
  'skipped',
  'todo',
  'cancelled',
];

export const SCOPE_LANE_TEST_REASONS = Object.freeze({
  'test/hosts/codex-registration.test.ts':
    'starts Codex systemd scopes whose host-wide reaper and cancellation checks race the other scope-lane tests',
  'test/ship/delivery-isolation.test.ts':
    'creates and kills systemd user scopes shared with the sandbox tests',
  'test/verdict/sandbox.test.ts':
    'creates and kills systemd user scopes shared with the delivery isolation tests',
});
export const EXCLUSIVE_TEST_REASONS = Object.freeze({
  'test/cli/delegate.test.ts':
    'asserts child termination within 1000 ms under CPU load',
  'test/foreman/credential-shape.test.ts':
    'bounds a CPU-bound credential scan to 2000 ms',
  'test/hosts/codex-stale-scope.test.ts':
    'asserts its unit is reaped by the host-wide reaper; concurrent CodexHost.start can reap it first',
});
export const SCOPE_LANE_TEST_FILES = Object.freeze(
  Object.keys(SCOPE_LANE_TEST_REASONS),
);
export const EXCLUSIVE_TEST_FILES = Object.freeze(
  Object.keys(EXCLUSIVE_TEST_REASONS),
);

function readDurations(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

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
  return Math.max(1, cores - 1);
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

export function planTestShards(files, shardCount, options = {}) {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1)
    throw new Error('test shard count must be a positive integer');
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string'))
    throw new Error('test shard plan requires a list of file paths');

  const selected = [...new Set(files)].sort();
  const laneNames = new Set(
    (options.laneFiles ?? SCOPE_LANE_TEST_FILES).map(normalizedFile),
  );
  const exclusiveNames = new Set(
    (options.exclusiveFiles ?? EXCLUSIVE_TEST_FILES).map(normalizedFile),
  );
  const exclusiveFiles = selected.filter((file) =>
    exclusiveNames.has(normalizedFile(file)),
  );
  const laneFiles = selected.filter(
    (file) =>
      !exclusiveNames.has(normalizedFile(file)) &&
      laneNames.has(normalizedFile(file)),
  );
  const regularFiles = selected.filter(
    (file) =>
      !exclusiveNames.has(normalizedFile(file)) &&
      !laneNames.has(normalizedFile(file)),
  );
  const table = Object.hasOwn(options, 'durations')
    ? options.durations
    : readDurations(
        options.durationsPath ??
          new URL('../../test/test-durations.json', import.meta.url),
      );
  const durations =
    table?.version === 1 &&
    table.files &&
    typeof table.files === 'object' &&
    !Array.isArray(table.files)
      ? table.files
      : {};
  const known = (file) => {
    const value = Object.hasOwn(durations, normalizedFile(file))
      ? durations[normalizedFile(file)]
      : undefined;
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  };
  const values = selected
    .map(known)
    .filter((value) => value !== undefined)
    .sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  const median =
    values.length === 0
      ? 1000
      : values.length % 2
        ? values[middle]
        : (values[middle - 1] + values[middle]) / 2;
  const weight = (file) => known(file) ?? median;
  const count = Math.min(shardCount, regularFiles.length + laneFiles.length);
  const shards = Array.from({ length: count }, () => []);
  const weights = Array.from({ length: count }, () => 0);
  if (laneFiles.length) {
    shards[0].push(...laneFiles);
    weights[0] = laneFiles.reduce((sum, file) => sum + weight(file), 0);
  }
  regularFiles.sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  for (const file of regularFiles) {
    let target = 0;
    for (let index = 1; index < count; index += 1) {
      if (
        weights[index] < weights[target] ||
        (weights[index] === weights[target] &&
          shards[index].length < shards[target].length)
      )
        target = index;
    }
    shards[target].push(file);
    weights[target] += weight(file);
  }
  return { shards, laneFiles, exclusiveFiles };
}

// Each phase completes before any group in the next phase starts.
export function scheduleTestGroups(plan, shardCount) {
  if (shardCount === 1) {
    const lane = new Set(plan.laneFiles);
    const files = [
      ...plan.shards.flat().filter((file) => !lane.has(file)),
      ...plan.laneFiles,
      ...plan.exclusiveFiles,
    ];
    return files.length ? [[{ files }]] : [];
  }
  const phases = [plan.shards.map((files) => ({ files }))];
  if (plan.exclusiveFiles.length) phases.push([{ files: plan.exclusiveFiles }]);
  return phases;
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
