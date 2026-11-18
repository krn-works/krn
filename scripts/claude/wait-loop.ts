import { hookStdin } from '../../src/harness/claude.ts';
import { withoutHeredocs } from './ci-poll.ts';

// PreToolUse hook for Bash: refuses an until/while loop that sleeps unless a `timeout N`
// bounds it. Lane loops of `until grep -q verdict log; do sleep N; done` ran for hours
// because the awaited word never appeared. It classifies only that shape.
const sleepLoop = /\b(?:until|while)\b[\s\S]*\bdo\b[\s\S]*\bsleep\b/u;
const bounded = /\btimeout\s+(?:-\S+\s+)*\d/u;

export function decide(payload: unknown): string | undefined {
  const raw = (payload as { tool_input?: { command?: unknown } } | null)
    ?.tool_input?.command;
  if (typeof raw !== 'string') return undefined;
  const command = withoutHeredocs(raw);
  if (!sleepLoop.test(command) || bounded.test(command)) return undefined;
  return "Refused: this Bash call loops with sleep and nothing bounds it, so a word that never appears holds the lane for hours. Nothing in this Bash call ran. Run the command (`npm run fast`, `bin/krn pr ship`) as a background shell and wait for its exit notification; `npm run fast` ends with `fast PASS: ...` or `fast FAIL (...): ...`, ship with `verdict: ...`. A wait that must poll is wrapped in `timeout N bash -c '...'` (scripts/claude/wait-loop.ts).";
}

export function main() {
  let payload: unknown;
  try {
    payload = JSON.parse(hookStdin());
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
