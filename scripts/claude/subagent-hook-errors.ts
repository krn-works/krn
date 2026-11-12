import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { isWorkerSession } from './worker-session.ts';

// One script, two events. A subagent's hook errors (a refused Bash call, a failing Stop
// hook) are visible only in its own transcript; the lead never saw them.
//
// Delivery channel (Claude Code hooks reference, #subagentstop): SubagentStop receives
// `agent_transcript_path`, `agent_id`, `agent_type`, but its `additionalContext` and
// `decision: block` go back to the SUBAGENT and keep it running, and the reference says
// "To inject context into the parent session after a subagent returns, use a PostToolUse
// hook". PostToolUse's Agent response is `async_launched` for background agents, so no
// parent hook fires when their task-notification arrives. Therefore SubagentStop counts the
// errors, appends the ledger line and parks it in a per-session pending file; the next
// PostToolUse in the parent (foreground Agent return, or any later tool call) delivers it
// as `additionalContext` and clears it. SubagentStop never blocks and prints nothing.

// A hook error is the whole tool result or user text: Claude Code writes it as
// `PreToolUse:Bash hook error: [<command>]: <stderr>` at the start of the entry. The same
// words further inside an entry are content the subagent read (a file, a transcript, a log
// summary), not an error it hit, so the pattern is anchored to the entry start.
const hookError =
  /^(PreToolUse|PostToolUse|Stop|SubagentStop|SessionStart|UserPromptSubmit)(:\w+)? hook (error|blocking error|failed)/u;
const shown = 2;
const width = 100;

export type Found = { count: number; first: string[] };

type Item = { content?: unknown; text?: unknown };

/** Each tool result or text block of a user message, as its own entry. */
function entries(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item: Item) => {
    if (typeof item?.text === 'string') return [item.text];
    if (typeof item?.content === 'string') return [item.content];
    if (Array.isArray(item?.content))
      return (item.content as Item[]).flatMap((part) =>
        typeof part?.text === 'string' ? [part.text] : [],
      );
    return [];
  });
}

/** Count user-message hook errors in a transcript, once per message and error text. */
export function scan(transcript: string): Found {
  const messages: string[] = [];
  for (const raw of transcript.split('\n')) {
    let entry: { type?: unknown; message?: { content?: unknown } } | null;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (entry?.type !== 'user') continue;
    const seen = new Set<string>();
    for (const body of entries(entry.message?.content)) {
      const match = hookError.exec(body);
      if (!match) continue;
      const mark = body.indexOf(']: ', match[0].length);
      const message = (
        mark < 0 ? '' : (body.slice(mark + 3).split('\n')[0] ?? '')
      )
        .trim()
        .slice(0, width);
      const key = `${match[0]}|${message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      messages.push(message ? `${match[0]}: ${message}` : match[0]);
    }
  }
  return { count: messages.length, first: messages.slice(0, shown) };
}

export function line(type: string, id: string, found: Found): string {
  return `subagent ${type} ${id}: ${found.count} hook error(s): ${found.first.join(' | ')}`;
}

function pendingPath(root: string, session: string) {
  return join(root, '.krn', 'runs', 'hook-errors', `pending-${session}.md`);
}

function stop(payload: Record<string, unknown>, root: string) {
  const path = payload.agent_transcript_path;
  if (typeof path !== 'string' || !existsSync(path)) return;
  const found = scan(readFileSync(path, 'utf8'));
  if (found.count === 0) return;
  const id = typeof payload.agent_id === 'string' ? payload.agent_id : '?';
  const type =
    typeof payload.agent_type === 'string' ? payload.agent_type : '?';
  const entry = `${line(type, id, found)}\n`;
  const dir = join(root, '.krn', 'runs', 'hook-errors');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'ledger.md'), `- ${entry}`);
  const session = payload.session_id;
  if (typeof session === 'string' && /^[\w-]+$/u.test(session))
    appendFileSync(pendingPath(root, session), entry);
}

/** The pending lines for this session, cleared as they are taken. */
export function deliver(payload: Record<string, unknown>, root: string) {
  const session = payload.session_id;
  if (typeof session !== 'string' || !/^[\w-]+$/u.test(session)) return;
  const path = pendingPath(root, session);
  if (!existsSync(path)) return;
  const taken = `${path}.taken`;
  try {
    renameSync(path, taken);
  } catch {
    return;
  }
  const body = readFileSync(taken, 'utf8').trim();
  rmSync(taken, { force: true });
  return body || undefined;
}

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
