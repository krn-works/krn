import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { emitContext, hookInput, object } from './context-io.ts';

// Missing counters are invalid, rather than evidence of a small context.
export function gaugeReading(transcript: string): {
  total: number | undefined;
  boundary: string | undefined;
} {
  let total: number | undefined;
  let boundary: string | undefined;
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = object(JSON.parse(line));
    } catch {
      continue; // The transcript writer may still be appending the last line.
    }
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      boundary = typeof entry.uuid === 'string' ? entry.uuid : line;
      total = undefined;
      continue;
    }
    if (entry.type !== 'assistant' || entry.isSidechain === true) continue;
    const message = object(entry.message);
    if (message.usage === undefined) continue;
    const usage = object(message.usage);
    const counters = [
      usage.input_tokens,
      usage.cache_read_input_tokens,
      usage.cache_creation_input_tokens,
    ];
    let sum = 0;
    for (const counter of counters) {
      if (
        typeof counter !== 'number' ||
        !Number.isSafeInteger(counter) ||
        counter < 0
      )
        throw new Error('Invalid usage');
      sum += counter;
    }
    if (!Number.isSafeInteger(sum)) throw new Error('Invalid total');
    total = sum;
  }
  return { total, boundary };
}

export function contextTotal(transcript: string): number | undefined {
  return gaugeReading(transcript).total;
}

// The budget is the auto-compact window the project configures, so the gauge
// and compaction share one number; advisories fire at 60% and 80% of it.
// A first lead turn measured 46-48k on 2026-11-01, well below the first one.
function budget(project: string): number {
  const path = join(project, '.claude/settings.json');
  if (!existsSync(path)) return 200000;
  const window = object(
    JSON.parse(readFileSync(path, 'utf8')),
  ).autoCompactWindow;
  if (window === undefined) return 200000;
  if (
    typeof window !== 'number' ||
    !Number.isSafeInteger(window) ||
    window < 100000 ||
    window > 1000000
  )
    throw new Error('Invalid autoCompactWindow');
  return window;
}

function tail(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - 256 * 1024);
    const buffer = Buffer.alloc(size - start);
    const count = readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, count).toString('utf8');
    // The first line may begin outside the read window.
    if (start === 0) return text;
    const newline = text.indexOf('\n');
    return newline < 0 ? '' : text.slice(newline + 1);
  } finally {
    closeSync(fd);
  }
}

async function capturePrompt(raw: string): Promise<void> {
  try {
    const input = object(JSON.parse(raw));
    const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
    if (
      typeof input.prompt === 'string' &&
      typeof root === 'string' &&
      typeof input.session_id === 'string'
    ) {
      const { capture } = await import('./operator-inbox-store.ts');
      capture(root, input.session_id, input.prompt);
    }
  } catch {
    /* capture never blocks the gauge or the prompt */
  }
}

if (import.meta.main) {
  try {
    const raw = readFileSync(0, 'utf8');
    // One process serves both prompt-time duties: record the prompt, then gauge.
    if (raw.includes('"UserPromptSubmit"')) await capturePrompt(raw);
    const input = hookInput(['UserPromptSubmit', 'PostToolUse'], raw);
    const { total, boundary } = gaugeReading(tail(input.transcriptPath));
    if (total === undefined) throw new Error('No usage');
    const window = budget(input.project);
    const first = Math.floor((window * 3) / 5);
    const second = Math.floor((window * 4) / 5);
    const directory = join(input.project, '.krn/runs/claude/context-gauge');
    const path = join(directory, `${input.sessionId}.json`);
    let highest = 0;
    let armedAt: string | undefined;
    let previous = 0;
    if (existsSync(path)) {
      const state = object(JSON.parse(readFileSync(path, 'utf8')));
      if (
        typeof state.highest !== 'number' ||
        !Number.isSafeInteger(state.highest) ||
        state.highest < 0
      )
        throw new Error('Invalid gauge state');
      highest = state.highest;
      if (typeof state.boundary === 'string') armedAt = state.boundary;
      if (Number.isSafeInteger(state.total)) previous = state.total as number;
    }
    // A compaction re-arms both thresholds. Its boundary line can leave the
    // read window before context grows back, so a large drop counts as one too.
    if (
      (boundary !== undefined && boundary !== armedAt) ||
      total < previous - 20000
    )
      highest = 0;
    const level = total >= second ? second : total >= first ? first : 0;
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ highest: level === 0 ? 0 : Math.max(level, highest), boundary: boundary ?? armedAt, total })}\n`,
      { mode: 0o600 },
    );
    if (level > highest) {
      const prefix = `Context at ${Math.floor(total / 1000)}k of ${Math.floor(window / 1000)}k.`;
      const finish = 'Finish the current step, then run krn-handoff.';
      const exhausted =
        'Context budget nearly exhausted. Finish the current step now, then run krn-handoff before starting any new work.';
      // Jumping past both thresholds still delivers the first advisory.
      emitContext(
        input.event,
        level === first
          ? `${prefix} ${finish}`
          : highest < first
            ? `${prefix} ${finish} ${exhausted}`
            : `${prefix} ${exhausted}`,
      );
    }
  } catch {
    /* Hooks fail open without adding misleading context. */
  }
}
