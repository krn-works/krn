// Grades one resumed session: did it repeat the recorded wrong decision? A mechanical regex over what the session wrote
// and the tools it called; the events come from the session's stream-json output (or a transcript, same message shape).
import type { Grader } from './agent-replay-cases.ts';

export type ReplayEvent = { kind: 'text' | 'tool'; text: string };

/** The text blocks and tool calls of the assistant messages in a stream-json or transcript body, in order. */
export function replayEvents(jsonl: string): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let o: { type?: string; message?: { content?: unknown } };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = o.message?.content;
    if (o.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const b of content as {
      type?: string;
      text?: string;
      input?: { command?: unknown };
    }[]) {
      if (b.type === 'text' && typeof b.text === 'string')
        events.push({ kind: 'text', text: b.text });
      else if (b.type === 'tool_use')
        events.push({
          kind: 'tool',
          text:
            typeof b.input?.command === 'string'
              ? b.input.command
              : JSON.stringify(b.input ?? {}),
        });
    }
  }
  return events;
}

/** True when the session made the wrong decision: a matching event not cleared by an earlier matching check. */
export function repeats(g: Grader, events: readonly ReplayEvent[]): boolean {
  const hit = new RegExp(g.pattern, 'iu');
  const clear = g.unlessBefore ? new RegExp(g.unlessBefore, 'iu') : undefined;
  if (g.finalText) {
    const last = events.findLastIndex((e) => e.kind === 'text');
    if (last < 0 || !hit.test(events[last]?.text ?? '')) return false;
    return !(
      clear &&
      events.slice(0, last).some((e) => e.kind === 'tool' && clear.test(e.text))
    );
  }
  let cleared = false;
  for (const e of events) {
    if (g.on === 'any' || g.on === e.kind) {
      if (hit.test(e.text) && !cleared) return true;
    }
    if (clear && e.kind === 'tool' && clear.test(e.text)) cleared = true;
  }
  return false;
}
