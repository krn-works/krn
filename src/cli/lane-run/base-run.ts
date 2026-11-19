// The base suite of a lane worktree, run once before the session: a base that is red or cannot run its suite fails the lane for free.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { failingTests, timeoutOnly } from '../../ci/test-failures.ts';
import { findContract } from '../../repo/contract.ts';
import { receiverEnv } from '../../repo/receiver-env.ts';
import { git } from '../git-with.ts';
import { exitBaseHostLoad, exitBaseRed } from './result.ts';
import { settledRun } from './test-output.ts';

const greenSchema = z.object({ command: z.string() });

/** Where a green base run is remembered: one file per base SHA, in the main checkout's ignored tmp. */
export function baseRunCache(main: string, sha: string): string {
  return join(main, '.krn', 'tmp', 'base-green', `${sha}.json`);
}

/** The longest the base suite may run before the lane gives up on it. */
export const baseRunTimeoutMs = 30 * 60 * 1000;

/** Whether the worktree still is the untouched base: HEAD is the base head and nothing is modified. */
export function untouchedBase(worktree: string, base: string): boolean {
  const read = (args: string[]) => {
    try {
      return git(worktree, args);
    } catch {
      return undefined;
    }
  };
  const head = read(['rev-parse', 'HEAD']);
  if (head === undefined) return false;
  const atBase = [base, `origin/${base}`].some(
    (ref) => read(['rev-parse', '--verify', '--quiet', ref]) === head,
  );
  return atBase && read(['status', '--porcelain']) === '';
}

/**
 * Runs the contract test once on the untouched lane worktree, through the settled runner the final check uses.
 * Undefined when the base is green (cached per base SHA) or has nothing to run; else the refusal: red exits
 * 72 naming the failing files, a run that failed on timeouts alone exits 78.
 */
export function baseSuiteFailure(
  main: string,
  worktree: string,
  base: string,
): { detail: string; exitCode: number } | undefined {
  const contract = findContract(worktree)?.contract;
  if (contract === undefined || contract.vacuous) return undefined;
  if (!untouchedBase(worktree, base)) return undefined;
  const sha = git(worktree, ['rev-parse', 'HEAD']);
  const cache = baseRunCache(main, sha);
  try {
    if (
      existsSync(cache) &&
      greenSchema.parse(JSON.parse(readFileSync(cache, 'utf8'))).command ===
        contract.test
    )
      return undefined;
  } catch {
    rmSync(cache, { force: true });
  }
  const { run } = settledRun(
    (line) =>
      spawnSync(line, {
        cwd: worktree,
        env: receiverEnv(worktree),
        shell: true,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: baseRunTimeoutMs,
        killSignal: 'SIGKILL',
      }),
    contract.test,
  );
  if (run.status === 0) {
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, JSON.stringify({ command: contract.test }));
    return undefined;
  }
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  const log = join(worktree, '.krn', 'tmp', 'base-run.log');
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, output);
  const files = failingTests(output);
  const named =
    files.length > 0
      ? `failing files ${files.join(', ')}`
      : `${contract.test} exited ${run.status ?? run.signal ?? 'killed'}`;
  return timeoutOnly(output)
    ? {
        detail: `the base suite failed with timeouts only (${named}; host load, not a defect; log ${log})`,
        exitCode: exitBaseHostLoad,
      }
    : {
        detail: `the base suite is red (${named}; log ${log})`,
        exitCode: exitBaseRed,
      };
}
