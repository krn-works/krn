// Ship's pre-push trial merge: a branch that would conflict with its base exits 76 before anything is pushed.
import type { Runner } from './command.ts';

/**
 * Trial-merges HEAD into `origin/<target>` without touching the work tree and returns the
 * conflicted paths, empty when the merge is clean. A failing merge-tree throws.
 */
export function conflictedPaths(
  cwd: string,
  target: string,
  runner: Runner,
): string[] {
  const trial = runner(
    'git',
    ['merge-tree', '--write-tree', '--name-only', `origin/${target}`, 'HEAD'],
    cwd,
  );
  if (trial.code === 0) return [];
  if (trial.code !== 1)
    throw new Error(`git merge-tree failed: ${trial.stderr.trim()}`);
  // Output: tree id, then conflicted paths, a blank line, then messages.
  const [, ...rest] = trial.stdout.split('\n');
  const end = rest.indexOf('');
  return end < 0 ? rest : rest.slice(0, end);
}

/** Returns when HEAD merges cleanly onto `origin/<target>`; throws exit 76 naming the conflicted paths otherwise. */
export function assertNoConflict(
  cwd: string,
  target: string,
  runner: Runner,
): void {
  const conflicted = conflictedPaths(cwd, target, runner);
  if (conflicted.length === 0) return;
  throw Object.assign(
    new Error(
      `conflict with origin/${target} in ${conflicted.join(', ')}: rebase and resolve by hand`,
    ),
    { exitCode: 76 },
  );
}
