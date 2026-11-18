// Reading a red test run: which files failed, and whether the failure is only host-load timeouts.

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes start with ESC.
export const ansi = /\u001b\[[0-9;]*m/gu;

/** The exit of a check whose failure is only timeouts that moved between a run and its rerun: host contention, not a defect. */
export const exitHostLoadFlake = 78;

/**
 * The test files a red test run names as failing: vitest and jest (`FAIL  file > name`,
 * `❯ file (n tests | m failed)`), node:test (`test at file:line:col`, TAP `location:` of a `not ok`) and pytest (`FAILED file::name`).
 */
export function failingTests(output: string): string[] {
  const files: string[] = [];
  // node:test TAP names the file only in the `location:` line of a `not ok` block.
  let failedBlock = false;
  for (const raw of output.replace(ansi, '').split('\n')) {
    const line = raw.trim();
    if (/^not ok\b/u.test(line)) failedBlock = true;
    else if (/^ok\b/u.test(line)) failedBlock = false;
    const file =
      (failedBlock
        ? /^location: '(.+?):\d+:\d+'$/u.exec(line)?.[1]
        : undefined) ??
      /^FAIL\s+(\S+)/u.exec(line)?.[1] ??
      /^❯\s+(\S+)\s+\(.*\bfailed\b/u.exec(line)?.[1] ??
      /^test at (.+?):\d+:\d+$/u.exec(line)?.[1] ??
      /^FAILED\s+([^\s:]+)::/u.exec(line)?.[1];
    if (file !== undefined && !files.includes(file)) files.push(file);
  }
  return files;
}

const timeoutMarker =
  /Test timed out in \d+\s?ms|test timed out after \d+\s?ms|testTimeoutFailure/iu;
/** Evidence of a real defect: an assertion, a crash, a missing module, a type or lint error. */
const defectMarker =
  /AssertionError|ERR_ASSERTION|\bTypeError\b|\bReferenceError\b|\bSyntaxError\b|Cannot find (module|package)|error TS\d+|Expected values|expected .+ to (be|equal|match|deeply|have|include)|lint\//u;

/** Whether a red run names at least one test timeout and no assertion, crash, type or lint failure. */
export function timeoutOnly(output: string): boolean {
  const text = output.replace(ansi, '');
  return timeoutMarker.test(text) && !defectMarker.test(text);
}

/**
 * A run and its rerun that both fail with timeouts alone, on a different set of test files:
 * the host was too loaded, nothing in the change is red.
 */
export function hostLoadFlake(first: string, again: string): boolean {
  if (!timeoutOnly(first) || !timeoutOnly(again)) return false;
  const before = failingTests(first);
  const after = failingTests(again);
  if (before.length === 0 || after.length === 0) return false;
  return (
    before.length !== after.length ||
    before.some((file) => !after.includes(file))
  );
}
