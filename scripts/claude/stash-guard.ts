import { readFileSync } from 'node:fs';

// PreToolUse hook for Bash: refuses `git stash` forms that change the stash
// stack. Every worktree of a repository shares one stack, so a lane's bare
// `git stash` / `git stash pop` can take another lane's edits (2026-11-10,
// t-cbkxj6w). Reading (`list`, `show`) and `apply <sha>` stay allowed.
const allowed = new Set(['list', 'show', 'apply']);
// `git` in command position (line start or after ; & | ( and env assignments),
// its leading options (-C <path>, -c <k=v>, --git-dir=...), then `stash`.
const stash =
  /(?:^|[;&|(\n])\s*(?:\w+=\S*\s+)*git((?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?|-\w+))*)\s+stash\b([^\n;&|)]*)/gmu;

function withoutHeredocs(command: string): string {
  const kept: string[] = [];
  let end: string | undefined;
  for (const line of command.split('\n')) {
    if (end !== undefined) {
      if (line.trim() === end) end = undefined;
      continue;
    }
    kept.push(line);
    end = /<<-?\s*['"]?(\w+)['"]?/u.exec(line)?.[1];
  }
  return kept.join('\n');
}

export function decide(payload: unknown): string | undefined {
  const raw = (payload as { tool_input?: { command?: unknown } } | null)
    ?.tool_input?.command;
  if (typeof raw !== 'string') return undefined;
  for (const match of withoutHeredocs(raw).matchAll(stash)) {
    const sub = (match[2] ?? '').trim().split(/\s+/u)[0] ?? '';
    if (allowed.has(sub)) continue;
    return `Refused: \`git stash${sub ? ` ${sub}` : ''}\` changes the stash stack, which every worktree of this repository shares; another lane's edits can be taken or lost. Nothing in this Bash call ran. Set work aside with a WIP commit (\`git commit -m wip\`, later \`git reset --soft HEAD~1\`); \`git stash list|show|apply <sha>\` stay allowed (scripts/claude/stash-guard.ts).`;
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
