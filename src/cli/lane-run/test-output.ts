import { ansi, failingTests, hostLoadFlake } from '../../ci/test-failures.ts';
import { rerunCommand } from '../../repo/contract.ts';

export { ansi, failingTests };

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
 * A test command run once, and when it fails naming test files, rerun on those files only. A pass on
 * the rerun makes the first failures flaky (recorded, not red); files that fail again keep the run red,
 * except that timeouts alone on a different set of files are `hostLoad`: contention, not a defect.
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
): { run: R; flaky: string[]; hostLoad?: boolean } {
  const text = (run: R) => `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  const first = execute(command);
  if (first.status === 0) return { run: first, flaky: [] };
  const files = failingTests(text(first));
  if (files.length === 0) return { run: first, flaky: [] };
  const again = execute(rerunCommand(command, files));
  if (again.status === 0) return { run: again, flaky: files };
  const repeated = failingTests(text(again));
  // The detail names the files that failed twice, else the ones the first run named.
  return {
    run: repeated.length > 0 ? again : first,
    flaky: files.filter((file) => !repeated.includes(file)),
    ...(hostLoadFlake(text(first), text(again)) ? { hostLoad: true } : {}),
  };
}
