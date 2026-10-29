import { readFileSync } from 'node:fs';

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Expected object');
  return value as Record<string, unknown>;
}

export function hookInput(eventNames: string[]) {
  const input = object(JSON.parse(readFileSync(0, 'utf8')));
  const { session_id, transcript_path, hook_event_name } = input;
  const project = process.env.CLAUDE_PROJECT_DIR;
  if (
    typeof session_id !== 'string' ||
    !/^[a-zA-Z0-9_-]+$/u.test(session_id) ||
    typeof transcript_path !== 'string' ||
    !transcript_path ||
    typeof hook_event_name !== 'string' ||
    !eventNames.includes(hook_event_name) ||
    !project
  )
    throw new Error('Invalid hook input');
  return {
    sessionId: session_id,
    transcriptPath: transcript_path,
    event: hook_event_name,
    project,
    source: input.source,
  };
}

export function emitContext(event: string, text: string) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: text },
    }),
  );
}
