import { readFileSync } from 'node:fs';

// PreToolUse hook for Bash: a test, typecheck or lint run piped into a text filter loses its
// exit code to the filter's (a piped `npm test` once printed `fail 0` while CI had 20
// failures). The hook allows it with `set -o pipefail; ` prepended through updatedInput, and
// refuses only when the command swallows the failure anyway. It classifies only that shape
// and never judges safety; anything it cannot classify is allowed unchanged.
const check =
  /^(?:npm (?:test|t|run (?:test\S*|fast|check|lint|typecheck|gate))|node (?:\S+ )*--test|tsc|biome)(?:\s|$)/u;
const filter = /^(?:head|tail|grep|rg|sed|awk)(?:\s|$)/u;
const prefix = /^(?:\w+=\S*\s+)*(?:npx\s+|exec\s+|time\s+)*/u;
const swallow = /\|\|\s*(?:true|:|exit 0)(?:\s|;|$)|;\s*(?:true|:)\s*$/u;

const stage = (text: string) => text.trim().replace(prefix, '');

export type Verdict = { refuse: string } | { rewrite: string } | undefined;

// A piped check that `set -o pipefail` rescues is rewritten; one whose failure the command
// swallows afterwards (`|| true`) is refused, because pipefail cannot restore its exit code.
export function judge(payload: unknown): Verdict {
  const command = (payload as { tool_input?: { command?: unknown } } | null)
    ?.tool_input?.command;
  if (typeof command !== 'string') return undefined;
  for (const list of command.split(/&&|\|\||;|\n/u)) {
    const [first, ...rest] = list.split(/\|&?/u).map(stage);
    if (!first || !check.test(first)) continue;
    if (!rest.some((next) => filter.test(next))) continue;
    if (swallow.test(command))
      return {
        refuse: `Refused: \`${list.trim()}\` pipes a test, typecheck or lint run into a filter and the command swallows its failure (\`|| true\`), which hides the exit code even under pipefail. Nothing in this Bash call ran. Redirect it to a log, read the exit code, then read the log: \`cmd > log 2>&1; echo exit=$?\`, then \`grep FAIL log\` or \`tail -n 40 log\` (scripts/claude/piped-check.ts).`,
      };
    return command.startsWith('set -o pipefail')
      ? undefined
      : { rewrite: `set -o pipefail; ${command}` };
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
  const verdict = judge(payload);
  if (!verdict) return;
  if ('refuse' in verdict) {
    process.stderr.write(`${verdict.refuse}\n`);
    process.exitCode = 2;
    return;
  }
  const input = (payload as { tool_input: Record<string, unknown> }).tool_input;
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason:
          'piped check rewritten with set -o pipefail so the run exit code survives the filter',
        updatedInput: { ...input, command: verdict.rewrite },
      },
    })}\n`,
  );
}
if (import.meta.main) main();
