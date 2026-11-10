import { readFileSync } from 'node:fs';

// PreToolUse hook for Bash: refuses polling CI from the shell (`gh run watch`,
// `gh pr checks --watch`, or a loop that sleeps between `gh pr`/`gh run`/`gh api`
// calls). Each poll is a turn that re-reads the whole context; `krn ci wait` blocks
// once. It classifies only that shape; anything it cannot classify is allowed.
const watch = /\bgh\s+(?:run\s+watch|pr\s+checks\b[^\n;&|]*--watch)\b/u;
const loop = /\b(?:while|until|for)\b/u;
const sleeps = /\bsleep\b/u;
const ghCall = /\bgh[\s'",]+(?:pr|run|api)\b/u;

// Heredoc bodies are data (notes, scripts under edit), not commands to run.
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
  const command = withoutHeredocs(raw);
  const polls =
    watch.test(command) ||
    (loop.test(command) && sleeps.test(command) && ghCall.test(command));
  if (!polls) return undefined;
  return 'Refused: this Bash call polls CI from the shell (gh watch, or a sleep loop around gh pr/run/api); every poll re-reads the whole context. Nothing in this Bash call ran. Block once instead: `bin/krn ci wait --repo krn-works/krn --pr <n> --head <sha> --base <sha>` with full 40-char SHAs (scripts/claude/ci-poll.ts).';
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
