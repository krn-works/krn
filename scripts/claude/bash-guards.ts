import { readFileSync } from 'node:fs';
import { decide as pollGuard } from './ci-poll.ts';
import { decide as leadRead } from './lead-file-read.ts';
import { judge as pipedCheck } from './piped-check.ts';
import { decide as stashGuard } from './stash-guard.ts';
import { decide as unpushedDelete } from './unpushed-delete.ts';

// One PreToolUse entry for Bash: the five command guards run in one process instead of
// five. Each guard stays its own module with its own tests and still runs standalone.
// A refusal (exit 2) wins over the piped-check rewrite, which is emitted only when no
// guard refuses; guards judge the command as the agent wrote it, as when they were
// separate entries.
const refusals = [
  (payload: unknown) => {
    const verdict = pipedCheck(payload);
    return verdict && 'refuse' in verdict ? verdict.refuse : undefined;
  },
  unpushedDelete,
  leadRead,
  pollGuard,
  stashGuard,
];

function main() {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
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
