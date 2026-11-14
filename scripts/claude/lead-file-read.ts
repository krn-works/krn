import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verdict } from '../../src/hook/lead-file-read.ts';

// PreToolUse hook entry for Bash and Read (logic: src/hook/lead-file-read.ts).
function main() {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const result = verdict(payload);
  if (!result) return;
  if ('refuse' in result) {
    process.stderr.write(`${result.refuse}\n`);
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
          'the over-long reading stage was cut to the lead read budget; the call is otherwise unchanged',
        updatedInput: { ...input, command: result.rewrite },
      },
    })}\n`,
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
