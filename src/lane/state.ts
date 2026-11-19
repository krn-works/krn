// The one reader of a lane's lifecycle evidence (ADR 0026). Read-only: `krn pr ship` writes the ship
// record; lane status, the lane budget and lane prune ask this module instead of reading it themselves.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { laneMergeVerdict, type MergeVerdict } from '../repo/merge-verdict.ts';
import { shipRecordDir } from '../repo/ship-record.ts';

/** What `krn pr ship` recorded when a lane merged: the merge commit, the lane tip it merged and when. */
type ShipRecord = {
  branch: string;
  sha: string;
  head?: string;
  at?: string;
  task?: string;
};

/** A lane as its evidence shows it now. */
export type Lane = {
  /** merged, pr-open, closed or unshipped; one rule for every reader. */
  verdict: MergeVerdict;
  record?: ShipRecord;
  /** The lane worktree, when it is still on disk. */
  worktree?: string;
  /** The lane tip: the worktree HEAD, else the branch ref; undefined when neither answers (a retired lane). */
  tip?: string;
};

const sha = /^[0-9a-f]{7,40}$/u;

function parseShipRecord(text: string): ShipRecord | undefined {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { branch, sha: merged, head, at, task } = value;
  if (typeof branch !== 'string' || branch === '') return undefined;
  if (typeof merged !== 'string' || !sha.test(merged)) return undefined;
  return {
    branch,
    sha: merged,
    ...(typeof head === 'string' ? { head } : {}),
    ...(typeof at === 'string' ? { at } : {}),
    ...(typeof task === 'string' ? { task } : {}),
  };
}

/** The ship record of a branch, or undefined when there is none or it is unusable. */
export function readShipRecord(
  main: string,
  branch: string,
): ShipRecord | undefined {
  try {
    const record = parseShipRecord(
      readFileSync(
        join(main, shipRecordDir, `${encodeURIComponent(branch)}.json`),
        'utf8',
      ),
    );
    return record?.branch === branch ? record : undefined;
  } catch {
    return undefined;
  }
}

/** Every usable ship record of the repository, by branch name. */
export function shipRecords(main: string): ShipRecord[] {
  const dir = join(main, shipRecordDir);
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      const record = parseShipRecord(readFileSync(join(dir, name), 'utf8'));
      return record ? [record] : [];
    } catch {
      return [];
    }
  });
}

function git(cwd: string, args: string[]): string | undefined {
  const out = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return out.status === 0 ? out.stdout.trim() : undefined;
}

/**
 * The lane `branch` of the main checkout `main`: its ship record, worktree, tip and merge verdict against
 * `origin/<base>`. A record counts only while it owns the tip (the shipped head, or for a record without a
 * head a tip committed no later than the ship); `pr` is the newest pull request of the branch when the caller
 * looked one up. The lane worktree is `<main>/.krn/worktrees/<branch>`; without it the branch ref is the tip.
 */
export function readLane(
  main: string,
  base: string,
  branch: string,
  pr?: { state: string },
): Lane {
  const record = readShipRecord(main, branch);
  const path = join(main, '.krn', 'worktrees', branch);
  const worktree = existsSync(path) ? path : undefined;
  const [at, ref] = worktree
    ? [worktree, 'HEAD']
    : [main, `refs/heads/${branch}`];
  const tip = git(at, ['rev-parse', '--verify', '--quiet', ref]);
  const committedAt = () => {
    const seconds = Number(git(at, ['log', '-1', '--format=%ct', ref]));
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
  };
  const verdict = laneMergeVerdict({
    record,
    head: tip,
    committedAt:
      record && record.head === undefined && tip !== undefined
        ? committedAt()
        : undefined,
    merged: (merge) =>
      spawnSync('git', [
        '-C',
        main,
        'merge-base',
        '--is-ancestor',
        merge,
        `origin/${base}`,
      ]).status === 0,
    pr,
  });
  return {
    verdict,
    ...(record ? { record } : {}),
    ...(worktree ? { worktree } : {}),
    ...(tip !== undefined ? { tip } : {}),
  };
}
