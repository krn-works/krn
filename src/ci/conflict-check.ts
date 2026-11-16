// Ship's pre-push trial merge: a branch that would conflict with its base exits 76 before anything is pushed.
import type { Runner } from './command.ts';

/**
 * Trial-merges HEAD into `origin/<target>` without touching the work tree. Returns when the
 * merge is clean; throws exit 76 naming the conflicted paths otherwise.
 */
export function assertNoConflict(
  cwd: string,
  target: string,
  runner: Runner,
): void {
  const onto = `origin/${target}`;
  const trial = runner(
    'git',
    ['merge-tree', '--write-tree', '--name-only', onto, 'HEAD'],
    cwd,
  );
  if (trial.code === 0) return;
  if (trial.code !== 1)
    throw new Error(`git merge-tree failed: ${trial.stderr.trim()}`);
  // Output: tree id, then conflicted paths, a blank line, then messages.
  const [, ...rest] = trial.stdout.split('\n');
  const conflicted = rest.slice(0, rest.indexOf(''));
  throw Object.assign(
    new Error(
      `conflict with ${onto} in ${conflicted.join(', ')}: rebase and resolve by hand`,
    ),
    { exitCode: 76 },
  );
}
