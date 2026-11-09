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
import { isAbsolute, join, relative, resolve } from 'node:path';
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

// Above the ceiling a session may only hand off: tools that start new work
// (delegation, web reads, edits outside agent state) are refused, while Bash,
// Read and Skill stay open because krn-handoff runs through them. The replay
// of host transcripts showed steps running 20-128k past a single advisory.
const startsWork = new Set([
  'Agent',
  'Task',
  'Workflow',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
]);

export function refusesAtCeiling(
  tool: unknown,
  toolInput: unknown,
  project: string,
): boolean {
  if (typeof tool !== 'string') return false;
  if (startsWork.has(tool)) return true;
  if (tool !== 'Write' && tool !== 'Edit') return false;
  const file =
    typeof toolInput === 'object' && toolInput !== null
      ? (toolInput as Record<string, unknown>).file_path
      : undefined;
  if (typeof file !== 'string') return true;
  const state = relative(join(project, '.krn'), resolve(project, file));
  const memory = relative(
    join(process.env.HOME ?? '/nonexistent', '.claude/projects'),
    resolve(project, file),
  );
  const inside = (path: string) =>
    path !== '' && !path.startsWith('..') && !isAbsolute(path);
  return !(inside(state) || inside(memory));
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
    const input = hookInput(
      ['UserPromptSubmit', 'PostToolUse', 'PreToolUse'],
      raw,
    );
    const { total, boundary } = gaugeReading(tail(input.transcriptPath));
    if (total === undefined) throw new Error('No usage');
    const window = budget(input.project);
    const first = Math.floor((window * 3) / 5);
    const second = Math.floor((window * 4) / 5);
    const ceiling = Math.floor((window * 9) / 10);
    if (input.event === 'PreToolUse') {
      const tool = object(JSON.parse(raw));
      if (
        total >= ceiling &&
        refusesAtCeiling(tool.tool_name, tool.tool_input, input.project)
      )
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `Context at ${Math.floor(total / 1000)}k is past the ${Math.floor(ceiling / 1000)}k ceiling of the ${Math.floor(window / 1000)}k budget. New work is refused; run krn-handoff now (Bash, Read, Skill and writes under .krn/ stay open).`,
            },
          }),
        );
      process.exit(0);
    }
    const directory = join(input.project, '.krn/runs/claude/context-gauge');
    const path = join(directory, `${input.sessionId}.json`);
    let highest = 0;
    let armedAt: string | undefined;
    let previous = 0;
    let advised = 0;
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
      if (Number.isSafeInteger(state.advised))
        advised = state.advised as number;
    }
    // A compaction re-arms both thresholds. Its boundary line can leave the
    // read window before context grows back, so a large drop counts as one too.
    if (
      (boundary !== undefined && boundary !== armedAt) ||
      total < previous - 20000
    ) {
      highest = 0;
      advised = 0;
    }
    const level = total >= second ? second : total >= first ? first : 0;
    // Past the second threshold the advisory repeats every 10k of growth, so
    // one long step cannot outrun it; the ceiling then refuses new work.
    const repeat =
      level === second && highest >= second && total >= advised + 10000;
    const speaks = level > highest || repeat;
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ highest: level === 0 ? 0 : Math.max(level, highest), boundary: boundary ?? armedAt, total, advised: speaks ? total : level === 0 ? 0 : advised })}\n`,
      { mode: 0o600 },
    );
    if (repeat && level <= highest) {
      emitContext(
        input.event,
        `Context at ${Math.floor(total / 1000)}k of ${Math.floor(window / 1000)}k, still past the handoff advisory. Stop the current step and run krn-handoff; at ${Math.floor(ceiling / 1000)}k new work is refused.`,
      );
    } else if (level > highest) {
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
