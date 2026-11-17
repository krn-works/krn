import { rerunCommand } from '../../repo/contract.ts';

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes start with ESC.
export const ansi = /\u001b\[[0-9;]*m/gu;

/** The last line that says something: vitest ends its output with a bare separator such as `⎯⎯⎯[3/3]⎯`. */
export function lastLine(text: string): string {
  const lines = text
    .replace(ansi, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\p{L}/u.test(line));
  return lines[lines.length - 1] ?? '';
}

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

/**
 * A test command run once, and when it fails naming test files, rerun on those files only. A pass on
 * the rerun makes the first failures flaky (recorded, not red); files that fail again keep the run red.
 */
export function settledRun<
  R extends {
    status: number | null;
    stdout?: string | null;
    stderr?: string | null;
  },
>(
  execute: (command: string) => R,
  command: string,
): { run: R; flaky: string[] } {
  const first = execute(command);
  if (first.status === 0) return { run: first, flaky: [] };
  const files = failingTests(`${first.stdout ?? ''}\n${first.stderr ?? ''}`);
  if (files.length === 0) return { run: first, flaky: [] };
  const again = execute(rerunCommand(command, files));
  if (again.status === 0) return { run: again, flaky: files };
  const repeated = failingTests(`${again.stdout ?? ''}\n${again.stderr ?? ''}`);
  // The detail names the files that failed twice, else the ones the first run named.
  return {
    run: repeated.length > 0 ? again : first,
    flaky: files.filter((file) => !repeated.includes(file)),
  };
}
