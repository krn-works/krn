const COUNT_FIELDS = [
  'tests',
  'passed',
  'failed',
  'skipped',
  'todo',
  'cancelled',
];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function zeroCounts() {
  return {
    tests: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    todo: 0,
    cancelled: 0,
  };
}

function validCounts(value) {
  if (!isRecord(value)) return false;
  return COUNT_FIELDS.every(
    (field) => Number.isSafeInteger(value[field]) && value[field] >= 0,
  );
}

function countsCoherent(counts) {
  return (
    counts.tests ===
    counts.passed +
      counts.failed +
      counts.skipped +
      counts.todo +
      counts.cancelled
  );
}

function addCounts(target, counts) {
  for (const field of COUNT_FIELDS) target[field] += counts[field];
}

function sameCounts(left, right) {
  return COUNT_FIELDS.every((field) => left[field] === right[field]);
}

export function validateTestSummary(value) {
  const errors = [];
  if (!isRecord(value) || value.version !== 1) {
    return { ok: false, errors: ['summary must be a version 1 object'] };
  }
  if (value.success !== true) errors.push('summary success is not true');
  if (!validCounts(value.counts)) {
    errors.push('global counts are incomplete or invalid');
  } else if (!countsCoherent(value.counts)) {
    errors.push('global test totals do not equal their outcome counts');
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    errors.push('summary has no per-file coverage');
  }

  if (validCounts(value.counts) && Array.isArray(value.files)) {
    const paths = new Set();
    const totals = zeroCounts();
    for (const [index, file] of value.files.entries()) {
      if (
        !isRecord(file) ||
        typeof file.file !== 'string' ||
        !file.file.trim()
      ) {
        errors.push(`file coverage ${index} has no path`);
        continue;
      }
      if (paths.has(file.file))
        errors.push(`duplicate file coverage: ${file.file}`);
      paths.add(file.file);
      if (!validCounts(file)) {
        errors.push(`file coverage is incomplete: ${file.file}`);
        continue;
      }
      if (!countsCoherent(file))
        errors.push(`file test totals are incoherent: ${file.file}`);
      if (file.tests < 1)
        errors.push(`file has no real test coverage: ${file.file}`);
      if (
        Object.hasOwn(file, 'durationMs') &&
        !(Number.isSafeInteger(file.durationMs) && file.durationMs >= 0)
      )
        errors.push(`file duration is invalid: ${file.file}`);
      addCounts(totals, file);
    }
    if (!sameCounts(totals, value.counts))
      errors.push('per-file totals do not match global counts');
  }

  if (isRecord(value.counts)) {
    if (value.counts.tests < 1 || value.counts.passed < 1)
      errors.push('summary has no passing declared tests');
    for (const field of ['failed', 'skipped', 'todo', 'cancelled']) {
      if (value.counts[field] !== 0)
        errors.push(`summary contains ${field} tests`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function summarizeTestEvents(events, expectedFiles, runnerExitCode = 0) {
  const errors = [];
  const expected = [...new Set(expectedFiles)].sort();
  const expectedSet = new Set(expected);
  const fileSummaries = new Map();
  const fileEvents = new Map(
    expected.map((file) => [
      file,
      { tests: 0, passed: 0, failed: 0, enqueued: 0, settled: 0 },
    ]),
  );
  const globalSummaries = [];

  if (expected.length === 0) errors.push('no selected test files');
  if (!Array.isArray(events)) errors.push('event stream is not an array');
  for (const event of Array.isArray(events) ? events : []) {
    if (
      !isRecord(event) ||
      typeof event.type !== 'string' ||
      !isRecord(event.data)
    ) {
      errors.push('event stream contains a malformed event');
      continue;
    }
    const { type, data } = event;
    if (
      type === 'test:skip' ||
      type === 'test:todo' ||
      (Object.hasOwn(data, 'skip') &&
        data.skip !== false &&
        data.skip !== null) ||
      (Object.hasOwn(data, 'todo') && data.todo !== false && data.todo !== null)
    )
      errors.push(`${type} event records a skip or todo`);
    const eventPath = data.entryFile ?? data.file;
    if (typeof eventPath === 'string' && eventPath.length > 0) {
      const reportedPath = eventPath;
      if (!expectedSet.has(reportedPath))
        errors.push(`event belongs to an unselected file: ${reportedPath}`);
    }

    if (type === 'test:summary') {
      if (typeof data.entryFile === 'string' && data.entryFile.length > 0) {
        const file = data.entryFile;
        if (!expectedSet.has(file)) {
          errors.push(`summary belongs to an unselected file: ${file}`);
        } else if (fileSummaries.has(file)) {
          errors.push(`duplicate per-file summary: ${file}`);
        } else {
          fileSummaries.set(file, data);
        }
      } else {
        globalSummaries.push(data);
      }
    }

    if (typeof data.entryFile === 'string' && expectedSet.has(data.entryFile)) {
      const seen = fileEvents.get(data.entryFile);
      if (type === 'test:enqueue') seen.enqueued += 1;
      if (type === 'test:pass' || type === 'test:fail') seen.settled += 1;
    }

    if (
      (type === 'test:pass' || type === 'test:fail') &&
      data.details?.type === 'test' &&
      typeof data.entryFile === 'string' &&
      expectedSet.has(data.entryFile)
    ) {
      const counts = fileEvents.get(data.entryFile);
      counts.tests += 1;
      counts[type === 'test:pass' ? 'passed' : 'failed'] += 1;
    }
  }

  if (globalSummaries.length !== 1)
    errors.push('event stream must contain exactly one global summary');
  for (const file of expected) {
    const summary = fileSummaries.get(file);
    if (!summary) {
      // The child's own summary is its last event and is occasionally lost
      // after every test reported (CI run 42486987437). Accept the file only
      // when every test it enqueued settled as a pass, so a file that stopped
      // early still fails.
      const seen = fileEvents.get(file);
      if (
        seen.tests > 0 &&
        seen.failed === 0 &&
        seen.enqueued > 0 &&
        seen.enqueued === seen.settled
      ) {
        fileSummaries.set(file, {
          success: true,
          counts: { ...zeroCounts(), tests: seen.tests, passed: seen.passed },
        });
      } else {
        errors.push(`missing per-file summary: ${file}`);
      }
      continue;
    }
    if (summary.success !== true) errors.push(`file summary failed: ${file}`);
    if (!validCounts(summary.counts)) {
      errors.push(`file summary counts are incomplete: ${file}`);
      continue;
    }
    if (!countsCoherent(summary.counts))
      errors.push(`file summary totals are incoherent: ${file}`);
    if (summary.counts.tests < 1)
      errors.push(`file has no declared tests: ${file}`);
    const observed = fileEvents.get(file);
    if (
      observed.tests !== summary.counts.tests ||
      observed.passed !== summary.counts.passed ||
      observed.failed !== summary.counts.failed
    )
      errors.push(`declared test events do not cover file summary: ${file}`);
  }
  if (fileSummaries.size !== expected.length)
    errors.push('per-file summaries do not match selected files');

  let counts = zeroCounts();
  const global = globalSummaries[0];
  if (global) {
    if (global.success !== true) errors.push('global test summary failed');
    if (!validCounts(global.counts)) {
      errors.push('global summary counts are incomplete');
    } else {
      counts = Object.fromEntries(
        COUNT_FIELDS.map((field) => [field, global.counts[field]]),
      );
      if (!countsCoherent(counts))
        errors.push('global summary totals are incoherent');
    }
  }
  if (global && validCounts(global.counts)) {
    const perFileTotals = zeroCounts();
    for (const file of expected) {
      const summary = fileSummaries.get(file);
      if (summary && validCounts(summary.counts))
        addCounts(perFileTotals, summary.counts);
    }
    if (!sameCounts(perFileTotals, counts))
      errors.push('per-file summaries do not match global summary');
  }
  if (counts.skipped > 0 || counts.todo > 0 || counts.cancelled > 0)
    errors.push('summary contains skipped, todo, or cancelled tests');
  if (counts.failed > 0) errors.push('summary contains failed tests');
  if (counts.tests < 1 || counts.passed < 1)
    errors.push('summary contains no passing declared tests');
  if (runnerExitCode !== 0) errors.push(`test runner exited ${runnerExitCode}`);

  const files = expected.map((file) => {
    const summary = fileSummaries.get(file);
    const counts =
      summary && validCounts(summary.counts)
        ? Object.fromEntries(
            COUNT_FIELDS.map((field) => [field, summary.counts[field]]),
          )
        : zeroCounts();
    // Wall time of the file's own test process; CI folds it into shard
    // weights (scripts/shard-weights-refresh.mjs).
    const duration = summary?.duration_ms;
    return Number.isFinite(duration) && duration >= 0
      ? { file, ...counts, durationMs: Math.round(duration) }
      : { file, ...counts };
  });
  const result = {
    summary: { version: 1, success: errors.length === 0, counts, files },
    errors: [...new Set(errors)],
  };
  const validated = validateTestSummary(result.summary);
  if (!validated.ok) {
    result.errors.push(...validated.errors);
    result.summary.success = false;
  }
  result.errors = [...new Set(result.errors)];
  return { ...result, ok: result.errors.length === 0 };
}
