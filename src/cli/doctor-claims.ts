// `krn doctor` claim section: each task claim older than N hours whose branch holds no commit beyond the base.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contractBase } from '../repo/contract.ts';
import { mainCheckoutRoot } from '../task/claims.ts';

export const CLAIM_STALE_EXIT = 66;
export const defaultClaimHours = 6;

/** Commits on `branch` that the base lacks; null when the branch does not exist. */
export type CommitProbe = (
  root: string,
  branch: string,
  base: string,
) => number | null;

export const gitCommitProbe: CommitProbe = (root, branch, base) => {
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (
    git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).status !== 0
  )
    return null;
  const remote = `refs/remotes/origin/${base}`;
  const ref =
    git('rev-parse', '--verify', '--quiet', remote).status === 0
      ? remote
      : `refs/heads/${base}`;
  const count = git('rev-list', '--count', branch, '--not', ref);
  return count.status === 0 ? Number(count.stdout.trim()) : null;
};

export function claimHoursOption(options: string[]): number {
  const at = options.indexOf('--claim-hours');
  if (at < 0) return defaultClaimHours;
  const hours = Number(options[at + 1]);
  return Number.isFinite(hours) && hours > 0 ? hours : defaultClaimHours;
}

export function staleClaimsReport(
  root: string,
  options: {
    hours?: number;
    now?: number;
    probe?: CommitProbe;
  } = {},
): { text: string; exitCode: number } {
  const hours = options.hours ?? defaultClaimHours;
  const now = options.now ?? Date.now();
  const probe = options.probe ?? gitCommitProbe;
  const dir = join(root, '.krn', 'task-claims');
  const lines: string[] = [];
  const names = existsSync(dir) ? readdirSync(dir).sort() : [];
  const base = contractBase(root);
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let claim: { id?: string; branch?: string; claimed?: string };
    try {
      claim = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const claimed = Date.parse(claim.claimed ?? '');
    if (!Number.isFinite(claimed) || typeof claim.branch !== 'string') continue;
    const age = (now - claimed) / 3_600_000;
    if (age < hours) continue;
    if ((probe(root, claim.branch, base) ?? 0) > 0) continue;
    lines.push(
      `claim-stale=${claim.id ?? name} claimed ${age.toFixed(1)}h ago on ${claim.branch} with no commit`,
    );
  }
  if (lines.length === 0) lines.push('claims=live');
  else
    lines.push(
      'claim-remedy=finish the lane or release the claim with `krn task release <id>`',
    );
  return {
    text: `${lines.join('\n')}\n`,
    exitCode: lines.length > 1 ? CLAIM_STALE_EXIT : 0,
  };
}

export function claimsReport(
  productRoot: string,
  options: string[],
): { text: string; exitCode: number } {
  return staleClaimsReport(mainCheckoutRoot(productRoot), {
    hours: claimHoursOption(options),
  });
}
