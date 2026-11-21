// Unpushed-delete hook.
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { findArchived } from '../task/archive.ts';
import { readClaim, readTaskText } from '../task/store.ts';
import { commandsOf, gitCall, resolveCommand } from './shell-reader.ts';

// PreToolUse hook for Bash: refuses `git branch -D` and `git worktree remove` when the
// branch tip is on no remote, names an open task in a `Ticket:` or `Refs:` trailer, and
// that task's file does not record the tip SHA. A lead once deleted the only copy of
// t-9ser2tw's implementation this way; it survived only as a dangling commit.
// A record in the claiming worktree's task copy counts, and so does a tip whose work
// already landed on a remote by squash merge (same patch-id). Anything it cannot
// classify is allowed.

// `repository` holds the git options that select the repository (`-C`, `--git-dir`, `--work-tree`).
type Target = {
  kind: 'branch' | 'worktree';
  name: string;
  repository?: string[];
  /** The command selects its repository with a word the shell expands: only the current checkout is known. */
  unresolved?: boolean;
};

export function targets(command: string): Target[] {
  const found: Target[] = [];
  for (const { words } of commandsOf(command)) {
    const call = gitCall(resolveCommand(words)?.argv ?? []);
    if (call === undefined) continue;
    const repository =
      call.repository.length > 0 && !call.unresolved
        ? call.repository
        : undefined;
    const unresolved = call.unresolved ? { unresolved: true } : {};
    const args = call.args.map((word) => word.text);
    if (call.verb === 'branch') {
      const force =
        args.includes('-D') ||
        ((args.includes('-d') || args.includes('--delete')) &&
          (args.includes('-f') || args.includes('--force')));
      if (!force) continue;
      for (const name of args.filter((arg) => !arg.startsWith('-')))
        found.push({
          kind: 'branch',
          name,
          ...(repository && { repository }),
          ...unresolved,
        });
    }
    if (call.verb === 'worktree' && args[0] === 'remove') {
      for (const name of args.slice(1).filter((arg) => !arg.startsWith('-')))
        found.push({
          kind: 'worktree',
          name,
          ...(repository && { repository }),
          ...unresolved,
        });
    }
  }
  return found;
}

// Where git runs: a directory, or a directory with the options the command selected its repository by.
type At = string | { cwd: string; options: readonly string[] };

function git(at: At, args: string[], input?: string): string {
  const [cwd, options] =
    typeof at === 'string' ? [at, []] : [at.cwd, at.options];
  return execFileSync('git', ['-C', cwd, ...options, ...args], {
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
    timeout: 3000,
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

const patchIds = (cwd: At, patch: string) =>
  git(cwd, ['patch-id', '--stable'], patch)
    .split('\n')
    .map((line) => line.split(' ')[0])
    .filter(Boolean);

// A squash merge leaves the branch tip on no remote although its work landed:
// the unpushed range's combined diff has the patch-id of one remote commit.
function squashMerged(cwd: At, tip: string): boolean {
  const first = git(cwd, [
    'rev-list',
    '--reverse',
    tip,
    '--not',
    '--remotes',
  ]).split('\n')[0];
  if (!first) return false;
  const base = git(cwd, ['rev-parse', '--verify', `${first}^`]);
  const [own] = patchIds(
    cwd,
    git(cwd, ['diff', '--no-color', '--no-ext-diff', base, tip]),
  );
  if (!own) return false;
  const landed = git(cwd, [
    'log',
    '-p',
    '--no-color',
    '--no-ext-diff',
    '--max-count=500',
    '--remotes',
    `^${base}`,
  ]);
  return patchIds(cwd, landed).includes(own);
}

// `krn task edit` on a claimed task writes into the claiming worktree's copy.
function claimTask(root: string, id: string): string {
  const worktree = readClaim(root, id)?.worktree;
  return typeof worktree === 'string' ? (readTaskText(worktree, id) ?? '') : '';
}

const read = (load: () => string) => {
  try {
    return load();
  } catch {
    return '';
  }
};

/** The opaque command that mentions a branch or remote-branch deletion, with its construct; the reader cannot say which ref it deletes. */
function opaqueDelete(command: string): string | undefined {
  for (const { words, opaque } of commandsOf(command)) {
    if (opaque === undefined) continue;
    const text = words.map((word) => word.text).join(' ');
    if (!/\bgit\b/u.test(text)) continue;
    const branch =
      /\bbranch\b/u.test(text) &&
      /(?:^|\s)(?:-[a-zA-Z]*[dD][a-zA-Z]*|--delete)(?:\s|$)/u.test(text);
    const push =
      /\bpush\b/u.test(text) && /(?:^|\s)(?:--delete|\+?:\S)/u.test(text);
    if (branch || push)
      return `Refused: the command uses ${opaque} and deletes a branch, so the hook cannot tell which ref it removes or whether it holds unpushed work. Run the deletion as a plain \`git branch -D <name>\` or \`git push <remote> --delete <name>\`.`;
  }
  return undefined;
}

export function decide(payload: unknown): string | undefined {
  const value = payload as {
    cwd?: unknown;
    tool_input?: { command?: unknown };
  } | null;
  const command = value?.tool_input?.command;
  const cwd = typeof value?.cwd === 'string' ? value.cwd : process.cwd();
  if (typeof command !== 'string') return undefined;
  const refusal = opaqueDelete(command);
  if (refusal !== undefined) return refusal;
  for (const target of targets(command)) {
    const at: At = target.repository
      ? {
          cwd,
          options: target.repository,
        }
      : cwd;
    try {
      let tip: string;
      try {
        tip =
          target.kind === 'branch'
            ? git(at, ['rev-parse', '--verify', `${target.name}^{commit}`])
            : git(
                isAbsolute(target.name)
                  ? target.name
                  : resolve(cwd, target.name),
                ['rev-parse', 'HEAD'],
              );
      } catch (error) {
        // Fail closed: an expanded repository word is unknown here, and the current checkout cannot prove the ref.
        if (target.unresolved)
          return `Refused: ${target.kind} ${target.name} is deleted in a repository the hook cannot resolve (the path is expanded by the shell). Run the command with a literal path, or from that repository.`;
        throw error;
      }
      if (
        git(at, ['rev-list', '--max-count=1', tip, '--not', '--remotes']) === ''
      )
        continue;
      const trailers = git(at, ['log', '-1', '--format=%B', tip]);
      const id = /^(?:Ticket|Refs):\s*(t-[a-z0-9]+)\s*$/mu.exec(trailers)?.[1];
      if (!id) continue;
      const root = dirname(
        git(at, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      );
      let task = readTaskText(root, id) ?? '';
      if (task === '') {
        // Closed and archived on main: that state wins over a stale open copy on the tip.
        if (read(() => findArchived(root, id)?.status ?? '') !== '') continue;
        // A lane that carried a pending task holds the only copy: the tip's own tree names it.
        task = git(at, ['show', `${tip}:tasks/${id}.json`]);
      }
      if ((JSON.parse(task) as { status?: unknown }).status !== 'open')
        continue;
      if (task.includes(tip.slice(0, 7))) continue;
      if (read(() => claimTask(root, id)).includes(tip.slice(0, 7))) continue;
      if (read(() => String(squashMerged(at, tip))) === 'true') continue;
      return `Refused: ${target.kind} ${target.name} holds unpushed commit ${tip.slice(0, 12)} of open task ${id}, and tasks/${id}.json does not record it. Push the branch, or record the SHA first: \`krn task edit ${id} --append-body "Unpushed work: ${tip}"\`.`;
    } catch {
      // An unreadable ref, task file or record cannot prove unrecorded work: allow this target.
    }
  }
  return undefined;
}
