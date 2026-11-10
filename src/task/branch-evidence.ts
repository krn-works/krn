import { spawnSync } from 'node:child_process';
import type { TaskRecord } from './record.ts';

/** One open-task branch name that neither the checkout nor origin holds. */
interface BranchMiss {
  branch: string;
  task: string;
}

const branchReference = /(?<![\w./-])(?:feat|fix|chore)\/[A-Za-z0-9][\w./-]*/gu;

/**
 * Lists every `feat/`, `fix/` or `chore/` branch named by an open task for
 * which `exists` is false, so a handoff cannot trust work on a deleted branch.
 */
export function branchMisses(
  records: Iterable<TaskRecord>,
  exists: (branch: string) => boolean,
): BranchMiss[] {
  const misses: BranchMiss[] = [];
  for (const record of records) {
    if (record.status !== 'open') continue;
    for (const branch of branchReferences([record.title, ...record.body]))
      if (!exists(branch)) misses.push({ branch, task: record.id });
  }
  return misses;
}

/** True when `root` has the branch locally or as `origin/<branch>`. */
export function gitBranchExists(root: string, branch: string): boolean {
  return [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`].some(
    (ref) =>
      spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', ref], {
        stdio: 'ignore',
      }).status === 0,
  );
}

export function formatBranchMiss(miss: BranchMiss): string {
  return `tasks/${miss.task}.json: missing branch ${miss.branch} (neither local nor origin)`;
}

function branchReferences(texts: string[]): string[] {
  const branches = new Set<string>();
  for (const text of texts)
    for (const [match] of text.matchAll(branchReference))
      branches.add(match.replace(/[.,:;/]+$/u, ''));
  return [...branches].sort();
}
