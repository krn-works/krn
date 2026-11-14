// `krn adopt <path> --verify`: a read-only report of the repository settings adoption relies on.
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { REQUIRED_CHECK_APP_ID } from '../repo/ci-admission-contract.ts';
import { contractBase, contractDeployAcknowledged } from '../repo/contract.ts';
import { deployRemedy, deployWorkflows } from './deploy.ts';

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

/** Active rules of a branch (`gh api repos/<repo>/rules/branches/<branch>`): rulesets, not classic protection. */
const rulesSchema = z.array(
  z.object({
    type: z.string(),
    parameters: z
      .object({
        required_status_checks: z
          .array(
            z.object({
              context: z.string(),
              integration_id: z.number().optional(),
            }),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
  }),
);

export interface VerifyReport {
  ok: boolean;
  gaps: string[];
}

/**
 * Gaps in the answers of `gh api repos/<repo>`, `gh api repos/<repo>/branches/<default>` and
 * `gh api repos/<repo>/rules/branches/<default>`: a required check counts from classic protection or a ruleset.
 */
export function verifyGaps(
  repoBody: string,
  branchBody: string,
  rulesBody = '[]',
): string[] {
  const repo = repoSchema.parse(JSON.parse(repoBody));
  const gaps: string[] = [];
  if (repo.allow_auto_merge !== true)
    gaps.push(
      'auto-merge is not allowed (repository setting allow_auto_merge)',
    );
  const contexts = new Set<string>();
  for (const check of branchSchema.parse(JSON.parse(branchBody)).protection
    ?.required_status_checks?.checks ?? [])
    if (check.app_id === ACTIONS_APP_ID) contexts.add(check.context);
  for (const rule of rulesSchema.parse(JSON.parse(rulesBody)))
    for (const check of rule.parameters?.required_status_checks ?? [])
      if (check.integration_id === ACTIONS_APP_ID) contexts.add(check.context);
  if (contexts.size !== 1)
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
  const branch = defaultBranch(repoBody);
  const branchBody = gh(root, `repos/{owner}/{repo}/branches/${branch}`);
  const rulesBody = gh(root, `repos/{owner}/{repo}/rules/branches/${branch}`);
  const gaps = verifyGaps(repoBody, branchBody, rulesBody);
  // krn.json `base` wins over the repository default, as for lanes.
  const deployBase = contractBase(root);
  const deploying = deployWorkflows(root, deployBase);
  if (deploying.length > 0 && !contractDeployAcknowledged(root))
    gaps.push(deployRemedy(deploying, deployBase));
  return { ok: gaps.length === 0, gaps };
}
