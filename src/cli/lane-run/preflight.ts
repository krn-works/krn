import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findContract } from '../../repo/contract.ts';
import { mainCheckoutRoot } from '../../task/claims.ts';
import { withFileLock } from '../lane-lock.ts';
import { git } from './git.ts';
import { exitInstallFailed, exitRedBaseline } from './result.ts';

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

/** Why the baseline test run failed: its exit and the failing test files, else its last meaningful line. */
export function baselineReason(run: {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error | undefined;
}): string {
  if (run.error !== undefined) return run.error.message;
  const exit = `exit ${run.status ?? 'signal'}`;
  const files = failingTests(`${run.stdout ?? ''}\n${run.stderr ?? ''}`);
  if (files.length > 0) {
    const shown = files.slice(0, 10).join(', ');
    const more = files.length > 10 ? ` and ${files.length - 10} more` : '';
    return `${exit}; failing: ${shown}${more}`;
  }
  return `${exit}: ${lastLine(`${run.stderr ?? ''}`) || lastLine(`${run.stdout ?? ''}`)}`;
}

/**
 * The contract test narrowed to `files`: the paths go after the last command, behind `--` when an
 * npm-style runner forwards them to its script (`npm --prefix packages/x test -- a.test.ts`).
 */
export function rerunCommand(test: string, files: readonly string[]): string {
  const quoted = files.map((file) => `'${file.replaceAll("'", "'\\''")}'`);
  const last = test.split(/&&|\|\||;/u).pop() ?? test;
  const forward =
    /\b(?:npm|pnpm|yarn|bun)\b/u.test(last) && !/\s--(?:\s|$)/u.test(last);
  return `${test}${forward ? ' --' : ''} ${quoted.join(' ')}`;
}

/** The lock that makes concurrent lanes of one repository run their baseline tests one at a time. */
export function baselineLockFile(main: string): string {
  return join(main, '.krn', 'tmp', 'lane-baseline.lock');
}

/** A lane sandbox settings file claude cannot load, else undefined. */
export function settingsFailure(settings: string): string | undefined {
  if (!existsSync(settings))
    return `sandbox settings file missing: ${settings}`;
  try {
    JSON.parse(readFileSync(settings, 'utf8'));
    return undefined;
  } catch (error) {
    return `sandbox settings file is not JSON: ${settings} (${(error as Error).message})`;
  }
}

/**
 * Whether the session's own git credentials reach origin and its base branch: an unreachable
 * remote or a token the remote refuses fails here in seconds, not after a model session.
 */
export function remoteFailure(
  repo: string,
  base: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const result = spawnSync(
    'git',
    ['-C', repo, 'ls-remote', '--exit-code', 'origin', `refs/heads/${base}`],
    {
      encoding: 'utf8',
      env: { ...env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 30000,
    },
  );
  if (result.status === 0) return undefined;
  if (result.status === 2) return `origin has no branch ${base}`;
  const said =
    result.error?.message ??
    (result.stderr.trim().split('\n')[0] || `exit ${result.status}`);
  return `origin unreachable with the lane credentials (git ls-remote: ${said})`;
}

/**
 * Before the session: the contract install runs in the worktree, then the contract test runs on the
 * clean base (a worktree whose HEAD is still origin/base). A string is the refusal; undefined starts the session.
 */
export function prepareWorktree(
  worktree: string,
  base: string,
  main: string = mainCheckoutRoot(worktree),
): { detail: string; exitCode: number } | undefined {
  const contract = findContract(worktree)?.contract;
  if (contract === undefined) return undefined;
  if (contract.vacuous)
    return {
      detail: `vacuous test command: ${contract.test} runs no real test, so a green run proves nothing; add one real test and a test command (krn.json "test", drop "vacuous"); no session started`,
      exitCode: exitRedBaseline,
    };
  const execute = (command: string) =>
    spawnSync(command, {
      cwd: worktree,
      shell: true,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    });
  const reason = (run: ReturnType<typeof execute>) =>
    run.error !== undefined
      ? run.error.message
      : `exit ${run.status ?? 'signal'}: ${lastLine(`${run.stderr ?? ''}`) || lastLine(`${run.stdout ?? ''}`)}`;
  if (contract.install !== undefined) {
    const installed = execute(contract.install);
    if (installed.status !== 0)
      return {
        detail: `install failed (${contract.install}, ${reason(installed)})`,
        exitCode: exitInstallFailed,
      };
  }
  if (
    git(worktree, ['rev-parse', 'HEAD']) !==
    git(worktree, ['rev-parse', `origin/${base}`])
  )
    return undefined;
  // Concurrent lanes take turns: a suite run by five lanes at once timed out and read as red.
  // A timing-flaky suite fails under host load and passes alone: a red run reruns only its
  // failing files once, and the baseline is red only when they fail again.
  const baseline = withFileLock(baselineLockFile(main), () => {
    const first = execute(contract.test);
    if (first.status === 0) return first;
    const files = failingTests(`${first.stdout ?? ''}\n${first.stderr ?? ''}`);
    if (files.length === 0) return first;
    const again = execute(rerunCommand(contract.test, files));
    if (again.status === 0) return again;
    // The detail names the files that failed twice, else the ones the first run named.
    return failingTests(`${again.stdout ?? ''}\n${again.stderr ?? ''}`).length >
      0
      ? again
      : first;
  });
  if (baseline.status !== 0)
    return {
      detail: `red baseline: ${contract.test} fails on a clean origin/${base} (${baselineReason(baseline)}); no session started`,
      exitCode: exitRedBaseline,
    };
  return undefined;
}
