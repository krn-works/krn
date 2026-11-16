import { hookStdin } from '../../src/harness/claude.ts';

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

// A wait loop on `pgrep -f PATTERN` never ends: the pattern is in the loop's own `bash -c`
// command line, so pgrep always finds at least that shell (same class as `pkill -f`).
const fullMatchWait =
  /\b(?:while|until)\b[^\n]*?\bpgrep\s+(?:-\w*f\w*|--full)\b/u;

const stage = (text: string) => text.trim().replace(prefix, '');

export type Verdict = { refuse: string } | { rewrite: string } | undefined;

// A piped check that `set -o pipefail` rescues is rewritten; one whose failure the command
// swallows afterwards (`|| true`) is refused, because pipefail cannot restore its exit code.
export function judge(payload: unknown): Verdict {
  const command = (payload as { tool_input?: { command?: unknown } } | null)
    ?.tool_input?.command;
  if (typeof command !== 'string') return undefined;
  if (fullMatchWait.test(command))
    return {
      refuse: `Refused: a \`while\`/\`until\` loop waits on \`pgrep -f\`, whose pattern also matches this loop's own shell command line, so the loop never ends (three lanes were left waiting forever). Nothing in this Bash call ran. Wait on a PID instead: start the job with \`cmd & pid=$!\` and \`wait $pid\` or \`while kill -0 $pid 2>/dev/null; do sleep 5; done\`; or run it with run_in_background and wait for the notification (scripts/claude/piped-check.ts).`,
    };
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

export function main() {
  let payload: unknown;
  try {
    payload = JSON.parse(hookStdin());
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
