// Ship's rebase of a branch whose only conflicts are generated files: regenerate them from the rebased source.
import type { Runner } from '../deliver/transport.ts';

/** Files a generator owns: a conflict in one is resolved by rerunning its command, never by hand. */
export const generatedFiles: Record<string, [string, string[]]> = {
  'docs/generated/capability-index.md': [
    'node',
    ['scripts/claude/capability-index.ts', '--write'],
  ],
  'docs/program/roadmap.md': ['node', ['scripts/claude/roadmap-prune.ts']],
};

const conflictExit = (message: string) =>
  Object.assign(new Error(message), { exitCode: 76 });

const lines = (text: string) => text.split('\n').filter((l) => l !== '');

/**
 * Rebases HEAD onto `origin/<target>` when merging them would conflict only in generated files,
 * regenerating each at every conflicting commit; true when it rebased (the push then needs
 * --force-with-lease). A conflict in any other file throws exit 76; no conflict changes nothing.
 */
export function rebaseGenerated(
  cwd: string,
  target: string,
  runner: Runner,
): boolean {
  const onto = `origin/${target}`;
  const trial = runner(
    'git',
    ['merge-tree', '--write-tree', '--name-only', onto, 'HEAD'],
    cwd,
  );
  if (trial.code === 0) return false;
  if (trial.code !== 1)
    throw new Error(`git merge-tree failed: ${trial.stderr.trim()}`);
  // Output: tree id, then conflicted paths, a blank line, then messages.
  const [, ...rest] = trial.stdout.split('\n');
  const conflicted = rest.slice(0, rest.indexOf(''));
  const foreign = conflicted.filter((path) => !(path in generatedFiles));
  if (foreign.length > 0)
    throw conflictExit(
      `conflict with ${onto} in ${foreign.join(', ')}: rebase and resolve by hand`,
    );

  const git = (args: string[]) =>
    runner('git', ['-c', 'core.editor=true', ...args], cwd);
  let step = git(['rebase', onto]);
  while (step.code !== 0) {
    const unmerged = lines(
      git(['diff', '--name-only', '--diff-filter=U']).stdout,
    );
    const other = unmerged.filter((path) => !(path in generatedFiles));
    if (unmerged.length === 0 || other.length > 0) {
      git(['rebase', '--abort']);
      throw conflictExit(
        `rebase onto ${onto} conflicts in ${(other.length > 0 ? other : [step.stderr.trim()]).join(', ')}: resolve by hand`,
      );
    }
    for (const path of unmerged) {
      const [command, args] = generatedFiles[path] as [string, string[]];
      const made = runner(command, args, cwd);
      if (made.code !== 0) {
        git(['rebase', '--abort']);
        throw new Error(`regenerating ${path} failed: ${made.stderr.trim()}`);
      }
    }
    git(['add', ...unmerged]);
    step = git(['rebase', '--continue']);
  }
  return true;
}
