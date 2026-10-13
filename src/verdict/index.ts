// Compose base-declared checks, sandbox execution, and verdict recording. ADR 0001.
import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Job } from '../core/index.ts';
import { type Registry, resolveChecks, resolveRegistry } from './registry.ts';
import {
  addWorktree,
  cleanupWorktrees,
  createWorktreeDirectory,
  execute,
  TeardownUnconfirmed,
} from './sandbox.ts';
import { evaluatorSurfaceChanges } from './surface.ts';

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

async function git(root: string, args: string[]): Promise<string> {
  const result = await new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>((resolveResult, reject) => {
    const child = spawn('git', ['-C', root, ...args], {
      cwd: root,
      env: {
        PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
        LANG: 'C',
        LC_ALL: 'C',
        HOME: '/tmp/krn-home',
        TMPDIR: '/tmp/krn-home',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
    child.once('error', reject);
    child.once('close', (status) => {
      clearTimeout(timer);
      resolveResult({ status, stdout, stderr });
    });
  });
  if (result.status !== 0)
    throw new Error(result.stderr || 'git command failed');
  return result.stdout.trim();
}

async function clean(root: string, sha: string): Promise<string | null> {
  if (await git(root, ['status', '--porcelain=v1', '--untracked-files=all']))
    return 'worktree is dirty';
  return (await git(root, ['rev-parse', 'HEAD'])) === sha
    ? null
    : 'HEAD changed';
}

export async function judge(
  job: Job,
  sha: string,
  base: string,
  ids: readonly string[],
  record: (event: VerdictEvent) => Promise<void>,
  signal?: AbortSignal,
): Promise<Verdict> {
  const root = realpathSync(
    resolve(
      job.repoRoot ??
        (await git(job.worktree, ['rev-parse', '--show-toplevel'])),
    ),
  );
  if (!/^[a-f0-9]{40,64}$/i.test(sha) || !/^[a-f0-9]{40,64}$/i.test(base))
    return {
      kind: 'refused',
      checks: [],
      findings: ['invalid base or target SHA'],
    };
  const before = await clean(job.worktree, sha);
  if (before) return { kind: 'refused', checks: [], findings: [before] };
  let registry: Registry;
  try {
    registry = await resolveRegistry(root, base);
  } catch (error) {
    return {
      kind: 'refused',
      checks: [],
      findings: [
        `invalid base registry: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const surfaceChanges = await evaluatorSurfaceChanges(
    root,
    base,
    sha,
    registry.protected,
  );
  if (surfaceChanges.length)
    return { kind: 'refused', checks: [], findings: surfaceChanges };
  const copies: string[] = [];
  let teardownUnconfirmed = false;
  const localController = signal ? undefined : new AbortController();
  const effectiveSignal = signal ?? localController?.signal;
  const onSigint = () => localController?.abort('SIGINT');
  const onSigterm = () => localController?.abort('SIGTERM');
  if (localController) {
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  }
  try {
    const checks = await resolveChecks(root, base, ids);
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
      if (effectiveSignal?.aborted)
        return {
          kind: 'refused',
          checks: results,
          findings: ['stopped'],
        };
      const copy = createWorktreeDirectory(directory);
      copies.push(copy);
      await addWorktree(root, copy, sha);
      results.push(
        await execute(
          root,
          copy,
          job,
          check.id,
          check.argv,
          check.timeoutMs,
          sha,
          effectiveSignal,
        ),
      );
    }
    if (effectiveSignal?.aborted)
      return {
        kind: 'refused',
        checks: results,
        findings: ['stopped'],
      };
    await record({ sha, checks: results });
    if (effectiveSignal?.aborted)
      return {
        kind: 'refused',
        checks: results,
        findings: ['stopped'],
      };
    const after = await clean(job.worktree, sha);
    if (after) return { kind: 'refused', checks: results, findings: [after] };
    const failed = results.filter((check) => check.exitCode !== 0);
    return failed.length
      ? {
          kind: 'fail',
          checks: results,
          findings: failed
            .slice(0, 2)
            .map((check) =>
              check.exitCode === 124
                ? `${check.id} timed out`
                : `${check.id} exited ${check.exitCode}`,
            ),
        }
      : { kind: 'pass', checks: results };
  } catch (error) {
    if (error instanceof TeardownUnconfirmed) {
      teardownUnconfirmed = true;
      process.exitCode = 1;
    }
    return {
      kind: 'refused',
      checks: [],
      findings: [error instanceof Error ? error.message : String(error)],
    };
  } finally {
    if (localController) {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    }
    if (teardownUnconfirmed) process.exitCode = 1;
    else await cleanupWorktrees(root, copies);
  }
}
