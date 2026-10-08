// Compose base-declared checks, sandbox execution, and verdict recording. ADR 0001.
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Job } from '../core/index.ts';
import { resolveChecks } from './registry.ts';
import {
  addWorktree,
  cleanupWorktrees,
  createWorktreeDirectory,
  execute,
} from './sandbox.ts';

export type CheckEvidence = {
  readonly id: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly sha256: string;
};
export type VerdictEvent = {
  readonly sha: string;
  readonly checks: readonly CheckEvidence[];
};
export type Verdict =
  | { readonly kind: 'pass'; readonly checks: readonly CheckEvidence[] }
  | {
      readonly kind: 'fail';
      readonly checks: readonly CheckEvidence[];
      readonly findings: readonly string[];
    }
  | {
      readonly kind: 'refused';
      readonly checks: readonly CheckEvidence[];
      readonly findings: readonly string[];
    };

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
      LANG: 'C',
      LC_ALL: 'C',
      HOME: '/tmp/krn-home',
      TMPDIR: '/tmp/krn-home',
    },
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw result.error ?? new Error(result.stderr || 'git command failed');
  return result.stdout.trim();
}

function clean(root: string, sha: string): string | null {
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=all']))
    return 'worktree is dirty';
  return git(root, ['rev-parse', 'HEAD']) === sha ? null : 'HEAD changed';
}

export async function judge(
  job: Job,
  sha: string,
  base: string,
  ids: readonly string[],
  record: (event: VerdictEvent) => Promise<void>,
): Promise<Verdict> {
  const root = realpathSync(
    resolve(
      job.repoRoot ?? git(job.worktree, ['rev-parse', '--show-toplevel']),
    ),
  );
  if (!/^[a-f0-9]{40,64}$/i.test(sha) || !/^[a-f0-9]{40,64}$/i.test(base))
    return {
      kind: 'refused',
      checks: [],
      findings: ['invalid base or target SHA'],
    };
  const before = clean(job.worktree, sha);
  if (before) return { kind: 'refused', checks: [], findings: [before] };
  const copies: string[] = [];
  let terminationSignal: NodeJS.Signals | undefined;
  const onSigint = () => {
    terminationSignal = 'SIGINT';
  };
  const onSigterm = () => {
    terminationSignal = 'SIGTERM';
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    const checks = resolveChecks(root, base, ids);
    const state = resolve(root, '.krn');
    const directory = resolve(state, 'tmp');
    mkdirSync(state, { recursive: true, mode: 0o700 });
    if (realpathSync(state) !== state)
      throw new Error('unsafe verdict state directory');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (realpathSync(directory) !== directory)
      throw new Error('unsafe verdict worktree directory');
    const results: CheckEvidence[] = [];
    for (const check of checks) {
      if (terminationSignal)
        return {
          kind: 'refused',
          checks: results,
          findings: [`interrupted by ${terminationSignal}`],
        };
      const copy = createWorktreeDirectory(directory);
      copies.push(copy);
      addWorktree(root, copy, sha);
      results.push(
        execute(root, copy, job, check.id, check.argv, check.timeoutMs, sha),
      );
    }
    if (terminationSignal)
      return {
        kind: 'refused',
        checks: results,
        findings: [`interrupted by ${terminationSignal}`],
      };
    await record({ sha, checks: results });
    if (terminationSignal)
      return {
        kind: 'refused',
        checks: results,
        findings: [`interrupted by ${terminationSignal}`],
      };
    const after = clean(job.worktree, sha);
    if (after) return { kind: 'refused', checks: results, findings: [after] };
    const failed = results.filter((check) => check.exitCode !== 0);
    return failed.length
      ? {
          kind: 'fail',
          checks: results,
          findings: failed
            .slice(0, 2)
            .map((check) => `${check.id} exited ${check.exitCode}`),
        }
      : { kind: 'pass', checks: results };
  } catch (error) {
    return {
      kind: 'refused',
      checks: [],
      findings: [error instanceof Error ? error.message : String(error)],
    };
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    cleanupWorktrees(root, copies);
  }
}
