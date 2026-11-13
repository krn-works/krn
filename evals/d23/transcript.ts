// Per-session transcript counts for one D23 arm: tool calls, hook events, and the hook messages the model reads.
// A project directory under ~/.claude/projects is shared by every session that ran in the same work path
// (repeats and reruns reuse it), so only the session's own transcript and its subagent transcripts count.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TranscriptCounts {
  toolCalls: number;
  /** Every hook record, including silent successes and the stop summary. */
  hookEvents: number;
  /** Hook records whose content reaches the model: any hook attachment except a silent success, and stop summaries that block or report errors or context. */
  hookMsgs: number;
}

/** The session's transcript files: `<sid>.jsonl` and everything under `<sid>/` (subagents). */
export function sessionFiles(projectDir: string, sessionId: string): string[] {
  if (!sessionId || !existsSync(projectDir)) return [];
  const out: string[] = [];
  const main = join(projectDir, `${sessionId}.jsonl`);
  if (existsSync(main)) out.push(main);
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  const sub = join(projectDir, sessionId);
  if (existsSync(sub)) walk(sub);
  return out;
}

export function countLines(lines: Iterable<string>): TranscriptCounts {
  const c: TranscriptCounts = { toolCalls: 0, hookEvents: 0, hookMsgs: 0 };
  for (const line of lines) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!d || typeof d !== 'object') continue;
    if (d.type === 'assistant') {
      const content = (d.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content))
        c.toolCalls += content.filter(
          (b) => b && typeof b === 'object' && b.type === 'tool_use',
        ).length;
    }
    const type = String(
      (d.attachment as { type?: unknown } | undefined)?.type ?? '',
    );
    if (type.startsWith('hook_')) {
      c.hookEvents++;
      if (type !== 'hook_success') c.hookMsgs++;
    } else if (d.subtype === 'stop_hook_summary') {
      c.hookEvents++;
      const nonEmpty = (v: unknown) =>
        Array.isArray(v) ? v.length > 0 : Boolean(v);
      if (
        d.preventedContinuation === true ||
        nonEmpty(d.hookErrors) ||
        nonEmpty(d.hookAdditionalContext)
      )
        c.hookMsgs++;
    }
  }
  return c;
}

export function countSession(
  projectDir: string,
  sessionId: string,
): TranscriptCounts {
  const total: TranscriptCounts = { toolCalls: 0, hookEvents: 0, hookMsgs: 0 };
  for (const f of sessionFiles(projectDir, sessionId)) {
    const c = countLines(readFileSync(f, 'utf8').split('\n'));
    total.toolCalls += c.toolCalls;
    total.hookEvents += c.hookEvents;
    total.hookMsgs += c.hookMsgs;
  }
  return total;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [projectDir, sessionId] = process.argv.slice(2);
  if (!projectDir) {
    process.stderr.write('usage: transcript.ts <project-dir> <session-id>\n');
    process.exit(64);
  }
  const c = countSession(projectDir, sessionId ?? '');
  process.stdout.write(
    `tool_calls=${c.toolCalls}\nhook_events=${c.hookEvents}\nhook_msgs=${c.hookMsgs}\n`,
  );
}
