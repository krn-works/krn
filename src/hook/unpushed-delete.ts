// Unpushed-delete hook.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { findArchived } from '../task/archive.ts';
import {
  commandsOf,
  gitCall,
  programName,
  resolveCommand,
} from './shell-reader.ts';

// PreToolUse hook for Bash: refuses `git branch -D` and `git worktree remove` when the
// branch tip is on no remote, names an open task in a `Ticket:` or `Refs:` trailer, and
// that task's file does not record the tip SHA. A lead once deleted the only copy of
// t-9ser2tw's implementation this way; it survived only as a dangling commit.
// A record in the claiming worktree's task copy counts, and so does a tip whose work
// already landed on a remote by squash merge (same patch-id). Anything it cannot
// classify is allowed.

type Target = { kind: 'branch' | 'worktree'; name: string };

export function targets(command: string): Target[] {
  const found: Target[] = [];
  for (const { words } of commandsOf(command)) {
    const argv = resolveCommand(words)?.argv ?? [];
    // A git run by another wrapper (`sudo git`, `xargs git`) deletes the same branch.
    const at = argv.findIndex((word) => programName(word) === 'git');
    const call = at < 0 ? undefined : gitCall(argv.slice(at));
    if (call === undefined) continue;
    const args = call.args.map((word) => word.text);
    if (call.verb === 'branch') {
      const force =
        args.includes('-D') ||
        ((args.includes('-d') || args.includes('--delete')) &&
          (args.includes('-f') || args.includes('--force')));
      if (!force) continue;
      for (const name of args.filter((arg) => !arg.startsWith('-')))
        found.push({ kind: 'branch', name });
    }
    if (call.verb === 'worktree' && args[0] === 'remove') {
      for (const name of args.slice(1).filter((arg) => !arg.startsWith('-')))
        found.push({ kind: 'worktree', name });
    }
  }
  return found;
}

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
    timeout: 3000,
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

const patchIds = (cwd: string, patch: string) =>
  git(cwd, ['patch-id', '--stable'], patch)
    .split('\n')
    .map((line) => line.split(' ')[0])
    .filter(Boolean);

// A squash merge leaves the branch tip on no remote although its work landed:
// the unpushed range's combined diff has the patch-id of one remote commit.
function squashMerged(cwd: string, tip: string): boolean {
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
  const claim = JSON.parse(
    readFileSync(join(root, '.krn', 'task-claims', `${id}.json`), 'utf8'),
  ) as { worktree?: unknown };
  if (typeof claim.worktree !== 'string') return '';
  return readFileSync(join(claim.worktree, 'tasks', `${id}.json`), 'utf8');
}

const read = (load: () => string) => {
  try {
    return load();
  } catch {
    return '';
  }
};

export function decide(payload: unknown): string | undefined {
  const value = payload as {
    cwd?: unknown;
    tool_input?: { command?: unknown };
  } | null;
  const command = value?.tool_input?.command;
  const cwd = typeof value?.cwd === 'string' ? value.cwd : process.cwd();
  if (typeof command !== 'string') return undefined;
  for (const target of targets(command)) {
    try {
      const tip =
        target.kind === 'branch'
          ? git(cwd, ['rev-parse', '--verify', `${target.name}^{commit}`])
          : git(
              isAbsolute(target.name) ? target.name : resolve(cwd, target.name),
              ['rev-parse', 'HEAD'],
            );
      if (
        git(cwd, ['rev-list', '--max-count=1', tip, '--not', '--remotes']) ===
        ''
      )
        continue;
      const trailers = git(cwd, ['log', '-1', '--format=%B', tip]);
      const id = /^(?:Ticket|Refs):\s*(t-[a-z0-9]+)\s*$/mu.exec(trailers)?.[1];
      if (!id) continue;
      const root = dirname(
        git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      );
      let task = read(() =>
        readFileSync(join(root, 'tasks', `${id}.json`), 'utf8'),
      );
      if (task === '') {
        // Closed and archived on main: that state wins over a stale open copy on the tip.
        if (read(() => findArchived(root, id)?.status ?? '') !== '') continue;
        // A lane that carried a pending task holds the only copy: the tip's own tree names it.
        task = git(cwd, ['show', `${tip}:tasks/${id}.json`]);
      }
      if ((JSON.parse(task) as { status?: unknown }).status !== 'open')
        continue;
      if (task.includes(tip.slice(0, 7))) continue;
      if (read(() => claimTask(root, id)).includes(tip.slice(0, 7))) continue;
      if (read(() => String(squashMerged(cwd, tip))) === 'true') continue;
      return `Refused: ${target.kind} ${target.name} holds unpushed commit ${tip.slice(0, 12)} of open task ${id}, and tasks/${id}.json does not record it. Push the branch, or record the SHA first: \`krn task edit ${id} --append-body "Unpushed work: ${tip}"\`.`;
    } catch {
      // An unreadable ref, task file or record cannot prove unrecorded work: allow this target.
    }
  }
  return undefined;
}
