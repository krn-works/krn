// `krn adopt <path> --verify`: a read-only report of the repository settings adoption relies on.
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { REQUIRED_CHECK_APP_ID } from '../repo/ci-admission-contract.ts';

const repoSchema = z.object({
  default_branch: z.string().min(1),
  allow_auto_merge: z.boolean().optional(),
});

const ACTIONS_APP_ID = REQUIRED_CHECK_APP_ID;
const branchSchema = z.object({
  protection: z
    .object({
      required_status_checks: z
        .object({
          checks: z
            .array(
              z.object({ context: z.string(), app_id: z.number().nullable() }),
            )
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

export interface VerifyReport {
  ok: boolean;
  gaps: string[];
}

/** Gaps in the answers of `gh api repos/<repo>` and `gh api repos/<repo>/branches/<default>`. */
export function verifyGaps(repoBody: string, branchBody: string): string[] {
  const repo = repoSchema.parse(JSON.parse(repoBody));
  const gaps: string[] = [];
  if (repo.allow_auto_merge !== true)
    gaps.push(
      'auto-merge is not allowed (repository setting allow_auto_merge)',
    );
  const checks =
    branchSchema.parse(JSON.parse(branchBody)).protection
      ?.required_status_checks?.checks ?? [];
  if (checks.filter((check) => check.app_id === ACTIONS_APP_ID).length !== 1)
    gaps.push(
      `branch ${repo.default_branch} has no single required status check from GitHub Actions`,
    );
  return gaps;
}

export function defaultBranch(repoBody: string): string {
  return repoSchema.parse(JSON.parse(repoBody)).default_branch;
}

function gh(root: string, path: string): string {
  const run = spawnSync('gh', ['api', path], { cwd: root, encoding: 'utf8' });
  if (run.status !== 0)
    throw new Error(
      `gh api ${path} failed (exit ${run.status ?? 'none'}): ${run.stderr.trim() || run.error?.message || ''}`,
    );
  return run.stdout;
}

/** Reads the repository of `root` through gh; changes no setting. */
export function verifyRepository(root: string): VerifyReport {
  const repoBody = gh(root, 'repos/{owner}/{repo}');
  const branchBody = gh(
    root,
    `repos/{owner}/{repo}/branches/${defaultBranch(repoBody)}`,
  );
  const gaps = verifyGaps(repoBody, branchBody);
  return { ok: gaps.length === 0, gaps };
}
