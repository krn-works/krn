import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimTask, inspectClaim } from '../../task/claims.ts';
import { mergeTaskRecords } from '../../task/record-merge.ts';
import { getTask } from '../../task/store.ts';
import { CliUsageError } from '../usage-error.ts';
import { git } from './git.ts';
import type { RedCheck } from './red-check.ts';

/** The worktree a failed run left behind, when it is the lane's own; anything else is a usage error. */
export function reusableLane(
  path: string,
  slug: string,
): { path: string; slug: string } {
  const branch = spawnSync(
    'git',
    ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'],
    { encoding: 'utf8' },
  );
  if (branch.status !== 0 || branch.stdout.trim() !== slug)
    throw new CliUsageError(
      `${path} exists but is not lane ${slug}'s worktree`,
    );
  return { path, slug };
}

/** Reuse the worktree a failed run left and take its claim again. */
/** A record the lead edited in the invoking checkout after the first run moves into the reused worktree; a worktree record the worker changed too is a divergence and refuses. */
export function carryEditedRecord(
  origin: string,
  path: string,
  task: string,
  base: string,
): void {
  const rel = `tasks/${task}.json`;
  const source = join(origin, rel);
  const target = join(path, rel);
  if (!existsSync(source) || !existsSync(target)) return;
  const edited = readFileSync(source, 'utf8');
  const current = readFileSync(target, 'utf8');
  if (edited === current) return;
  const shown = (ref: string) => {
    const result = spawnSync('git', ['show', `${ref}:${rel}`], {
      cwd: path,
      encoding: 'utf8',
    });
    return result.status === 0 ? result.stdout : undefined;
  };
  const original = shown(`origin/${base}`) ?? shown('HEAD');
  // The invoking checkout never moved from the base record: the worktree's own changes stand.
  if (edited === original) return;
  if (original === undefined || current === original) {
    writeFileSync(target, edited);
    return;
  }
  // Both changed (the lane closed the task, the lead appended a rework note): merge disjoint edits.
  const merge = mergeTaskRecords({
    base: original,
    lane: current,
    main: edited,
  });
  if (!('merged' in merge))
    throw new CliUsageError(
      'conflict' in merge
        ? `${rel} differs between ${origin} and the lane worktree ${path}: both changed ${merge.conflict}; reconcile them before rerunning`
        : `${rel} cannot be merged between ${origin} and the lane worktree ${path}: ${merge.invalid}`,
    );
  writeFileSync(source, merge.merged);
  if (merge.merged === current) return;
  writeFileSync(target, merge.merged);
  // Committed, so the lane's clean-tree check passes and the shipped commit carries the note.
  git(path, ['add', '--', rel]);
  git(path, ['commit', '-q', '-m', carrySubject(task), '-m', `Refs: ${task}`]);
}

/** The subject of the commit a rerun makes to carry the invoking checkout's record edits into the lane. */
export function carrySubject(task: string): string {
  return `chore(tasks): carry the lead's record edits into the lane (${task})`;
}

/** Commits after the red Check's head other than a record carry; a rewritten history counts as new work. */
export function commitsSinceRed(
  path: string,
  red: RedCheck,
  task: string,
): string[] {
  const log = spawnSync('git', ['log', '--format=%s', `${red.sha}..HEAD`], {
    cwd: path,
    encoding: 'utf8',
  });
  if (log.status !== 0) return ['history rewritten since the red Check'];
  return log.stdout
    .split('\n')
    .filter((line) => line !== '' && line !== carrySubject(task));
}

export async function reclaimLane(
  main: string,
  path: string,
  slug: string,
  task: string,
  actor: string,
  origin: string,
  base: string,
): Promise<{ path: string; slug: string }> {
  const lane = reusableLane(path, slug);
  carryEditedRecord(origin, path, task, base);
  // The task closed in the lane worktree: an earlier run delivered it and only the ship failed.
  if (getTask(path, task).status === 'closed') return lane;
  // A run that died before it released its own claim leaves it live: the same actor and worktree resume it.
  const held = inspectClaim(main, task);
  if (
    held.state === 'live' &&
    held.claim?.actor === actor &&
    held.claim.worktree === realpathSync(path)
  )
    return lane;
  await claimTask(main, task, {
    actor,
    worktree: path,
    reason: `lane ${slug}`,
  });
  return lane;
}
