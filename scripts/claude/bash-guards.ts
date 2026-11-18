import { hookStdin } from '../../src/harness/claude.ts';
import { decide as stashGuard } from '../../src/hook/stash.ts';
import { decide as unpushedDelete } from '../../src/hook/unpushed-delete.ts';
import { decide as pollGuard } from './ci-poll.ts';
import { judge as pipedCheck } from './piped-check.ts';
import { decide as waitLoop } from './wait-loop.ts';

// One PreToolUse entry for Bash: the command guards run in one process instead of
// several. Each guard stays its own module with its own tests and still runs standalone.
// A refusal (exit 2) wins over the piped-check rewrite, which is emitted only when no
// guard refuses; guards judge the command as the agent wrote it, as when they were
// separate entries.
const refusals = [
  (payload: unknown) => {
    const verdict = pipedCheck(payload);
    return verdict && 'refuse' in verdict ? verdict.refuse : undefined;
  },
  unpushedDelete,
  pollGuard,
  waitLoop,
  stashGuard,
];

export function main() {
  let payload: unknown;
  try {
    payload = JSON.parse(hookStdin());
  } catch {
    return;
  }
  for (const refuse of refusals) {
    const reason = refuse(payload);
    if (reason) {
      process.stderr.write(`${reason}\n`);
      process.exitCode = 2;
      return;
    }
  }
  const verdict = pipedCheck(payload);
  if (!verdict || 'refuse' in verdict) return;
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
