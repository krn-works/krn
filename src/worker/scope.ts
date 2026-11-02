import { lstatSync } from 'node:fs';
import { join, matchesGlob, relative } from 'node:path';
import { z } from 'zod';
import { git } from './git.ts';
import { gitMetadataBaseline } from './git-metadata.ts';
import { WorkerError } from './state.ts';
import { untrackedBaseline } from './untracked.ts';

export { git } from './git.ts';

const policySchema = z.object({
  supportedVersions: z.array(z.string()).nonempty(),
  forbidden: z.array(z.string()).nonempty(),
  review: z.array(z.string()),
});
export function loadPolicy(repo: string, startCommit: string) {
  try {
    return policySchema.parse(
      JSON.parse(git(repo, 'show', `${startCommit}:spec/worker-scope.json`)),
    );
  } catch {
    throw new WorkerError(65, 'invalid worker policy at start commit');
  }
}
export async function scopeBaseline(
  repo: string,
  startCommit: string,
  run: string,
  allows: string[],
) {
  const policy = loadPolicy(repo, startCommit);
  const flags = () => {
    try {
      return git(repo, 'ls-files', '-v', '-z')
        .split('\0')
        .filter((entry) => /^[a-zS] /.test(entry));
    } catch {
      throw new WorkerError(70, 'worker path enumeration failed');
    }
  };
  const initialFlags = new Set(flags());
  const metadata = gitMetadataBaseline(repo);
  const protectedRoots = [
    '.krn',
    ...policy.forbidden
      .map((glob) => glob.split(/[?*[{]/, 1)[0]?.replace(/\/$/, '') ?? '')
      .filter(Boolean),
  ];
  const untracked = await untrackedBaseline(
    repo,
    startCommit,
    run,
    protectedRoots,
    policy.forbidden,
  );
  return async () => {
    const violations = metadata();
    // Preserve the established internal-error refusal for a damaged index.
    // Other metadata (such as config) must be checked before invoking Git.
    if (
      !violations.length ||
      violations.some((path) => path.endsWith('/index'))
    )
      for (const entry of flags())
        if (!initialFlags.has(entry)) violations.push(entry.slice(2));
    // A damaged config may prevent Git enumeration altogether. Report its
    // forbidden change before invoking any Git command in the worker tree.
    if (violations.length)
      return {
        changed: violations,
        scope_violations: violations,
        needs_lead_note: [],
      };
    return checkScope(
      repo,
      startCommit,
      run,
      allows,
      policy,
      await untracked(),
    );
  };
}

function checkScope(
  repo: string,
  startCommit: string,
  run: string,
  allows: string[],
  policy: z.infer<typeof policySchema>,
  untracked: string[],
) {
  let diff: string;
  try {
    diff = git(repo, 'diff', '--name-only', '--no-renames', '-z', startCommit);
  } catch {
    throw new WorkerError(70, 'worker path enumeration failed');
  }
  const names = [...diff.split('\0').filter(Boolean), ...untracked];
  const ownRun = relative(repo, run);
  const changed = [...new Set(names)].sort();
  const scope_violations: string[] = [];
  const needs_lead_note: string[] = [];
  for (const path of changed) {
    let symlink = false;
    try {
      symlink = lstatSync(join(repo, path)).isSymbolicLink();
    } catch {
      /* Deleted paths still undergo tier checks. */
    }
    if (!symlink && (path === ownRun || path.startsWith(`${ownRun}/`)))
      continue;
    if (
      symlink ||
      path.startsWith('../') ||
      policy.forbidden.some((glob) => matchesGlob(path, glob))
    )
      scope_violations.push(path);
    else if (
      !allows.some((glob) => matchesGlob(path, glob)) &&
      policy.review.some((glob) => matchesGlob(path, glob))
    )
      needs_lead_note.push(path);
  }
  return {
    changed: changed.filter((p) => p !== ownRun && !p.startsWith(`${ownRun}/`)),
    scope_violations,
    needs_lead_note,
  };
}
