import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gaugeReading } from './context-gauge.ts';
import { object } from './context-io.ts';

// Replays a recorded Claude Code transcript through the real context-gauge
// hook: each recorded tool result becomes a PostToolUse call and each
// operator prompt a UserPromptSubmit call, with the transcript cut at that
// point. It answers whether the gauge would have advised inside a step
// (a turn the model kept working on after the advisory) and how far that
// step and the session ran past it.

const gauge = fileURLToPath(new URL('./context-gauge.ts', import.meta.url));
// The hook reads the last 256 KiB; twice that keeps its view identical.
const view = 512 * 1024;

export type HookEvent = {
  line: number;
  event: 'PostToolUse' | 'UserPromptSubmit';
};

function entry(line: string): Record<string, unknown> | undefined {
  try {
    return object(JSON.parse(line));
  } catch {
    return undefined;
  }
}

// Tool results carry the assistant message they answer; operator prompts
// carry their source. Sidechain (subagent) lines never reach the lead's hook.
export function hookEvents(lines: string[]): HookEvent[] {
  const events: HookEvent[] = [];
  lines.forEach((line, index) => {
    const item = entry(line);
    if (item?.type !== 'user' || item.isSidechain === true) return;
    if (typeof item.sourceToolAssistantUUID === 'string')
      events.push({ line: index, event: 'PostToolUse' });
    else if (typeof item.promptSource === 'string')
      events.push({ line: index, event: 'UserPromptSubmit' });
  });
  return events;
}

export type Replay = {
  window: number;
  peak: number;
  advisories: Array<{
    line: number;
    event: string;
    total: number;
    // The model kept working in the same turn after this advisory.
    midStep: boolean;
    // The highest context that turn reached before it ended.
    stepPeak: number;
  }>;
};

export function replay(transcript: string, window: number): Replay {
  const lines = transcript.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += Buffer.byteLength(line) + 1;
  }
  const bytes = Buffer.from(transcript);
  const totals = lines.map((line) => gaugeReading(line).total);
  const prompts = hookEvents(lines)
    .filter((item) => item.event === 'UserPromptSubmit')
    .map((item) => item.line);
  const root = mkdtempSync(join(tmpdir(), 'context-replay-'));
  try {
    mkdirSync(join(root, '.claude'));
    writeFileSync(
      join(root, '.claude/settings.json'),
      JSON.stringify({ autoCompactWindow: window }),
    );
    const path = join(root, 'transcript.jsonl');
    const advisories: Replay['advisories'] = [];
    for (const { line, event } of hookEvents(lines)) {
      // A prompt hook runs before its prompt is recorded.
      const end = event === 'PostToolUse' ? line + 1 : line;
      const stop = starts[end] ?? bytes.length;
      writeFileSync(path, bytes.subarray(Math.max(0, stop - view), stop));
      const result = spawnSync(process.execPath, [gauge], {
        env: { ...process.env, CLAUDE_PROJECT_DIR: root },
        encoding: 'utf8',
        input: JSON.stringify({
          session_id: 'replay',
          transcript_path: path,
          hook_event_name: event,
        }),
      });
      if (result.status !== 0) throw new Error(result.stderr);
      if (!result.stdout) continue;
      const turnEnd = prompts.find((prompt) => prompt > line) ?? lines.length;
      const reading = gaugeReading(
        bytes.subarray(Math.max(0, stop - view), stop).toString('utf8'),
      ).total;
      const later = totals.slice(end, turnEnd);
      advisories.push({
        line,
        event,
        total: reading ?? 0,
        midStep: event === 'PostToolUse' && later.some((t) => t !== undefined),
        stepPeak: Math.max(reading ?? 0, ...later.map((t) => t ?? 0)),
      });
    }
    const peak = Math.max(0, ...totals.map((t) => t ?? 0));
    return { window, peak, advisories };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--window');
  const window = flag < 0 ? 400000 : Number(args[flag + 1]);
  const files = args.filter((_, index) => index !== flag && index !== flag + 1);
  if (!files.length || !Number.isSafeInteger(window)) {
    process.stderr.write(
      'usage: context-replay.ts [--window <tokens>] <transcript.jsonl>...\n',
    );
    process.exit(64);
  }
  for (const file of files) {
    const result = replay(readFileSync(file, 'utf8'), window);
    const first = result.advisories[0];
    const verdict =
      first === undefined
        ? 'none'
        : first.midStep
          ? `mid-step at ${Math.floor(first.total / 1000)}k (step peaked ${Math.floor(first.stepPeak / 1000)}k)`
          : `between steps at ${Math.floor(first.total / 1000)}k`;
    process.stdout.write(`${JSON.stringify({ file, ...result, verdict })}\n`);
  }
}
