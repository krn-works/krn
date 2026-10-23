import { statSync } from 'node:fs';
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

export const SERIAL_TEST_REASONS = Object.freeze({
  'test/cli/delegate.test.ts':
    'preflight interruption asserts child termination under one second, which is sensitive to parallel shard CPU load',
  'test/foreman/credential-shape.test.ts':
    'whole-file credential scans enforce a hard two-second child bound, which is sensitive to parallel shard CPU load',
  'test/hosts/codex-stale-scope.test.ts':
    'asserts systemd scope teardown within the configured runtime grace plus 1.5 seconds',
  'test/isolation-gate.test.ts':
    'checks repo-global strict-test-events-* directory deltas while child wrappers start and exit',
  'test/ledger/paperclip-cli.test.ts':
    'contains a 450ms timeout assertion and live process-group/systemd-scope cleanup checks',
  'test/ship/delivery-isolation.test.ts':
    'contains a 15s B1 cancellation bound and live process-tree/scope teardown checks; K=4 load observed 18.1s against the assertion',
  'test/trace/index.test.ts':
    'trace lock refusal and reclaimer assertions require completion within five seconds, which is sensitive to parallel shard CPU load',
  'test/verdict/sandbox.test.ts':
    'live SIGTERM asserts verdict scope teardown within eight seconds and exercises systemd/bwrap cleanup',
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
  return Math.max(1, Math.min(4, Math.floor(cores / 4)));
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
        return { file, size: statSync(file).size };
      } catch {
        return { file, size: 0 };
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

  return { shards, serialFiles: finalSerialFiles };
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
