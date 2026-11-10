import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// PreToolUse hook for Bash: refuses `git branch -D` and `git worktree remove` when the
// branch tip is on no remote, names an open task in a `Ticket:` or `Refs:` trailer, and
// that task's file does not record the tip SHA. A lead once deleted the only copy of
// t-9ser2tw's implementation this way; it survived only as a dangling commit.
// Anything it cannot classify is allowed.

type Target = { kind: 'branch' | 'worktree'; name: string };

const words = (text: string) =>
  text
    .trim()
    .split(/\s+/u)
    .map((word) => word.replace(/^['"]|['"]$/gu, ''));

export function targets(command: string): Target[] {
  const found: Target[] = [];
  for (const part of command.split(/&&|\|\||;|\n|\|/u)) {
    const argv = words(part);
    const git = argv.indexOf('git');
    if (git < 0) continue;
    let rest = argv.slice(git + 1);
    while (rest[0] === '-C' || rest[0] === '-c') rest = rest.slice(2);
    const [verb, ...args] = rest;
    if (verb === 'branch') {
      const force =
        args.includes('-D') ||
        ((args.includes('-d') || args.includes('--delete')) &&
          (args.includes('-f') || args.includes('--force')));
      if (!force) continue;
      for (const name of args.filter((arg) => !arg.startsWith('-')))
        found.push({ kind: 'branch', name });
    }
    if (verb === 'worktree' && args[0] === 'remove') {
      for (const name of args.slice(1).filter((arg) => !arg.startsWith('-')))
        found.push({ kind: 'worktree', name });
    }
  }
  return found;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 3000,
  }).trim();
}

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
      const task = readFileSync(join(root, 'tasks', `${id}.json`), 'utf8');
      if ((JSON.parse(task) as { status?: unknown }).status !== 'open')
        continue;
      if (task.includes(tip.slice(0, 7))) continue;
      return `Refused: ${target.kind} ${target.name} holds unpushed commit ${tip.slice(0, 12)} of open task ${id}, and tasks/${id}.json does not record it. Push the branch, or record the SHA first: \`krn task edit ${id} --append-body "Unpushed work: ${tip}"\` (scripts/claude/unpushed-delete.ts).`;
    } catch {}
  }
  return undefined;
}

function main() {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const reason = decide(payload);
  if (reason) {
    process.stderr.write(`${reason}\n`);
    process.exitCode = 2;
  }
}
if (import.meta.main) main();
