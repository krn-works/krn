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
 * A clean merge of a branch that changes a generated file and is not based on `onto`: the base
 * may have moved the generator's inputs, so rebase, rerun the generators of the files the
 * branch changed and amend when their output differs. False when nothing needed doing.
 */
function refreshGenerated(
  cwd: string,
  onto: string,
  runner: Runner,
  git: (args: string[]) => ReturnType<Runner>,
): boolean {
  if (git(['merge-base', '--is-ancestor', onto, 'HEAD']).code === 0)
    return false;
  const touched = lines(
    git(['diff', '--name-only', `${onto}...HEAD`]).stdout,
  ).filter((path) => path in generatedFiles);
  if (touched.length === 0) return false;
  const step = git(['rebase', onto]);
  if (step.code !== 0) {
    git(['rebase', '--abort']);
    throw conflictExit(
      `rebase onto ${onto} conflicts: ${step.stderr.trim()}: resolve by hand`,
    );
  }
  for (const path of touched) {
    const [command, args] = generatedFiles[path] as [string, string[]];
    const made = runner(command, args, cwd);
    if (made.code !== 0)
      throw new Error(`regenerating ${path} failed: ${made.stderr.trim()}`);
  }
  if (git(['status', '--porcelain', '--', ...touched]).stdout.trim() !== '') {
    git(['add', ...touched]);
    const amended = git(['commit', '--amend', '--no-edit']);
    if (amended.code !== 0)
      throw new Error(
        `amending regenerated files failed: ${amended.stderr.trim()}`,
      );
  }
  return true;
}

/**
 * Rebases HEAD onto `origin/<target>` when merging them would conflict only in generated files,
 * regenerating each at every conflicting commit; true when it rebased (the push then needs
 * --force-with-lease). A conflict in any other file throws exit 76; a clean merge is rebased and regenerated only when the branch changed a generated file.
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
  const git = (args: string[]) =>
    runner('git', ['-c', 'core.editor=true', ...args], cwd);
  if (trial.code === 0) return refreshGenerated(cwd, onto, runner, git);
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
