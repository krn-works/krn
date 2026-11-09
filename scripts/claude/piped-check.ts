import { readFileSync } from 'node:fs';

// PreToolUse hook for Bash: refuses a test, typecheck or lint run piped into a text filter,
// because the filter's exit code replaces the run's (a piped `npm test` once printed
// `fail 0` while CI had 20 failures). It classifies only that shape and never judges
// safety; anything it cannot classify is allowed.
const check =
  /^(?:npm (?:test|t|run (?:test\S*|fast|check|lint|gate|preflight))|node (?:\S+ )*--test|tsc|biome)(?:\s|$)/u;
const filter = /^(?:head|tail|grep|rg|sed|awk)(?:\s|$)/u;
const prefix = /^(?:\w+=\S*\s+)*(?:npx\s+|exec\s+|time\s+)*/u;

const stage = (text: string) => text.trim().replace(prefix, '');

export function decide(payload: unknown): string | undefined {
  const command = (payload as { tool_input?: { command?: unknown } } | null)
    ?.tool_input?.command;
  if (typeof command !== 'string') return undefined;
  for (const list of command.split(/&&|\|\||;|\n/u)) {
    const [first, ...rest] = list.split(/\|&?/u).map(stage);
    if (!first || !check.test(first)) continue;
    if (!rest.some((next) => filter.test(next))) continue;
    return `Refused: \`${list.trim()}\` pipes a test, typecheck or lint run into a filter, which hides its exit code. Nothing in this Bash call ran, including its other commands. Redirect it to a log, read the exit code, then read the log: \`cmd > log 2>&1; echo exit=$?\`, then \`grep FAIL log\` or \`tail -n 40 log\` (scripts/claude/piped-check.ts).`;
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
main();
