import { readFileSync } from 'node:fs';
import { isWorkerSession } from '../../src/hook/session.ts';
import { deliver, stop } from '../../src/hook/subagent-hook-errors.ts';

// SubagentStop and PostToolUse hook entry (logic and delivery channel: src/hook/subagent-hook-errors.ts).
function main() {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8')) as Record<string, unknown>;
  } catch {
    return;
  }
  const root =
    process.env.CLAUDE_PROJECT_DIR ??
    (typeof payload.cwd === 'string' ? payload.cwd : process.cwd());
  try {
    if (payload.hook_event_name === 'SubagentStop') return stop(payload, root);
    if (payload.hook_event_name !== 'PostToolUse') return;
    const body = deliver(payload, root);
    if (!body) return;
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: body,
        },
      })}\n`,
    );
  } catch {
    // A diagnostic hook must never fail the session.
  }
}
if (import.meta.main && !isWorkerSession()) main();
