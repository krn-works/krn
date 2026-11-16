// Context gauge hook: advisories and ceiling.
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
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  configHome,
  emitContext,
  hookInput,
  hookStdin,
  projectPath,
  promptCounters,
} from '../harness/claude.ts';
import { projectsStore } from '../harness/transcripts.ts';
import { isWorkerSession } from '../hook/session.ts';
import { object } from './io.ts';

// Missing counters are invalid, rather than evidence of a small context.
/**
 * The prompt the model saw last in this turn. A turn that calls the advisor carries
 * `usage.iterations` (executor, advisor, executor) and its top-level counters sum both
 * executor calls, so the context is the last `message` iteration, not the total.
 */
function lastPrompt(usage: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(usage.iterations)) return usage;
  for (let i = usage.iterations.length - 1; i >= 0; i -= 1) {
    const step = object(usage.iterations[i]);
    if (step.type === 'message') return step;
  }
  return usage;
}

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
    const counters = promptCounters(lastPrompt(object(message.usage)));
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

// The budget is the auto-compact window, so the gauge and compaction share one
// number; advisoriesOf places the handoff advisories. Claude Code resolves the
// window as CLAUDE_CODE_AUTO_COMPACT_WINDOW, then the project settings, then the
// user settings (code.claude.com model-config and settings docs): the user file
// ~/.claude/settings.json holds the one global window and a project sets its
// own only to override it. "auto" is the model's tuned window, which for the
// native 1M models compacts "at about 967K tokens by default".
const autoWindow = 967000;
// KRN's default window when nothing is set: the gauge advises against it even
// though Claude Code itself would compact near 967K.
export const defaultWindow = 400000;

function windowValue(window: unknown): number | undefined {
  if (window === undefined || window === '') return undefined;
  if (window === 'auto') return autoWindow;
  const value = typeof window === 'string' ? Number(window) : window;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 100000 ||
    value > 1000000
  )
    throw new Error('Invalid autoCompactWindow');
  return value;
}

function windowSetting(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const window = object(
    JSON.parse(readFileSync(path, 'utf8')),
  ).autoCompactWindow;
  // A string in settings is invalid; only the environment variable is text.
  if (typeof window === 'string' && window !== 'auto')
    throw new Error('Invalid autoCompactWindow');
  return windowValue(window);
}

function budget(project: string): number {
  return (
    windowValue(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) ??
    windowSetting(projectPath(project, 'settings.json')) ??
    windowSetting(join(configHome(), 'settings.json')) ??
    defaultWindow
  );
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

// Above the ceiling a session may only hand off. The replay of host
// transcripts showed steps running 20-128k past a single advisory and, with
// Bash and Read left open, sessions growing a further 116k past the ceiling,
// so the ceiling admits only what delivery-handoff runs: Skill and ToolSearch,
// writes under agent state or memory, reads of agent state or memory (or
// bounded reads elsewhere), and Bash commands built from handoff commands.
const handoffTools = new Set(['Skill', 'ToolSearch']);
// Each segment of an admitted Bash command starts with one of these.
const handoffCommand =
  /^(?:cd|echo|true|(?:bin\/)?krn|git|node scripts\/claude\/(?:handoff-requests|operator-inbox|successor-launch)\.ts)(?:\s|$)/;
// Host mode (the gauge installed in ~/.claude/settings.json for every
// project) also admits the context-relay handoff: its relay script, herdr
// or hc to verify the successor, and bd for Beads trackers.
const relayCommand =
  /^(?:herdr|hc|bd|(?:~|\$HOME|\$\{HOME\}|\/home\/[^/\s]+)\/\.claude\/skills\/context-relay\/scripts\/relay\.sh)(?:\s|$)/;
// The continuation prompt and handoff documents a relay writes.
const relayDocument = /(?:PROMPT|handoff)[^/]*\.md$/i;
// A bounded Read elsewhere still fits a handoff that checks one fact.
export const ceilingReadLines = 200;

function field(toolInput: unknown, name: string): unknown {
  return typeof toolInput === 'object' && toolInput !== null
    ? (toolInput as Record<string, unknown>)[name]
    : undefined;
}

// The thresholds are fractions of the window, so one global window setting
// moves all three: advisories at 1/2 and 5/8, the ceiling at 3/4. The 400k
// window gives 200k/250k/300k. The quarter above the ceiling serves only the
// handoff before compaction; a step that overshoots the second advisory by
// more than 50k meets the ceiling's refusal. 200k is a bounded step past the
// measured band on the operator's order, not a measured safe point: the
// evidence (.krn/runs/lead/context-budget/evidence.md) shows cost rising with
// context and no quality data past 200k. The window moves again only on its
// band's own evidence.
export function advisoriesOf(window: number): {
  first: number;
  second: number;
} {
  return {
    first: Math.floor(window / 2),
    second: Math.floor((window * 5) / 8),
  };
}

export function ceilingOf(window: number): number {
  return Math.floor((window * 3) / 4);
}

export function handoffBash(command: string, host = false): boolean {
  // A substitution would run a command the allowlist never sees.
  if (/[`]|\$\(|<\(/.test(command)) return false;
  const segments = command
    .split(/&&|\|\||[;|\n]/)
    .map((part) => part.trim().replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, ''))
    .filter((part) => part !== '');
  return (
    segments.length > 0 &&
    segments.every(
      (part) => handoffCommand.test(part) || (host && relayCommand.test(part)),
    )
  );
}

export function refusesAtCeiling(
  tool: unknown,
  toolInput: unknown,
  project: string,
  host = false,
): boolean {
  if (typeof tool !== 'string') return true;
  if (handoffTools.has(tool)) return false;
  if (tool === 'Bash') {
    const command = field(toolInput, 'command');
    return typeof command !== 'string' || !handoffBash(command, host);
  }
  if (tool !== 'Write' && tool !== 'Edit' && tool !== 'Read') return true;
  const file = field(toolInput, 'file_path');
  if (typeof file !== 'string') return true;
  const state = relative(join(project, '.krn'), resolve(project, file));
  const memory = relative(projectsStore(), resolve(project, file));
  const inside = (path: string) =>
    path !== '' && !path.startsWith('..') && !isAbsolute(path);
  if (inside(state) || inside(memory)) return false;
  if (host && tool !== 'Read' && relayDocument.test(file)) return false;
  if (tool !== 'Read') return true;
  const limit = field(toolInput, 'limit');
  return !(typeof limit === 'number' && limit > 0 && limit <= ceilingReadLines);
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
      const { capture, promptOrigin } = await import(
        '../memory/operator-inbox-store.ts'
      );
      capture(
        root,
        input.session_id,
        input.prompt,
        process.env,
        promptOrigin(input.transcript_path, input.prompt_id),
      );
    }
  } catch {
    /* capture never blocks the gauge or the prompt */
  }
}

// A project that wires its own gauge (KRN, directly or through its hook dispatcher) would otherwise be gauged twice.
export function wiresOwnGauge(project: string): boolean {
  return ['settings.json', 'settings.local.json'].some((name) => {
    const path = projectPath(project, name);
    return (
      existsSync(path) &&
      /context-gauge|src\/dispatch\/main\.ts/u.test(readFileSync(path, 'utf8'))
    );
  });
}

export async function main(): Promise<void> {
  if (isWorkerSession()) return;
  try {
    const host = process.argv.includes('--host');
    const raw = hookStdin();
    // One process serves both prompt-time duties: record the prompt, then gauge.
    if (!host && raw.includes('"UserPromptSubmit"')) await capturePrompt(raw);
    const input = hookInput(
      ['UserPromptSubmit', 'PostToolUse', 'PreToolUse'],
      raw,
    );
    if (host && wiresOwnGauge(input.project)) return;
    const handoff = host
      ? 'hand off with the context-relay skill'
      : 'run delivery-handoff';
    const { total, boundary } = gaugeReading(tail(input.transcriptPath));
    if (total === undefined) throw new Error('No usage');
    let window = defaultWindow;
    let notice: string | undefined;
    // One hook output per run: the notice rides with an advisory when one fires.
    const say = (text: string) => {
      emitContext(input.event, [notice, text].filter(Boolean).join(' '));
      notice = undefined;
    };
    try {
      window = budget(input.project);
    } catch {
      // A broken window setting must not drop the ceiling: gauge against the
      // default window and say so once per session, outside the tool hot path.
      const note = join(
        input.project,
        '.krn/runs/claude/context-gauge',
        `${input.sessionId}.invalid-window`,
      );
      if (input.event !== 'PreToolUse' && !existsSync(note)) {
        mkdirSync(dirname(note), { recursive: true });
        writeFileSync(note, '', { mode: 0o600 });
        notice = `Context gauge: the autoCompactWindow setting is invalid; gauging against the default ${Math.floor(defaultWindow / 1000)}k window.`;
      }
    }
    const { first, second } = advisoriesOf(window);
    const ceiling = ceilingOf(window);
    if (input.event === 'PreToolUse') {
      const tool = object(JSON.parse(raw));
      // A headless lane session cannot hand off, so the ceiling does not apply to it.
      if (
        process.env.KRN_SESSION_CLASS !== 'lane' &&
        total >= ceiling &&
        refusesAtCeiling(tool.tool_name, tool.tool_input, input.project, host)
      )
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `Context at ${Math.floor(total / 1000)}k is past the ${Math.floor(ceiling / 1000)}k ceiling of the ${Math.floor(window / 1000)}k budget. New work is refused; ${handoff} now (Skill, handoff Bash commands (krn, git, cd, echo, node scripts/claude/{handoff-requests,operator-inbox,successor-launch}.ts${host ? ', herdr, hc, bd, context-relay scripts' : ''}), reads and writes under .krn/${host ? ' and *PROMPT*/handoff*.md' : ''}, and Read with limit <= ${ceilingReadLines} stay open).`,
            },
          }),
        );
      return;
    }
    // Host mode keeps its state out of the projects it gauges.
    const directory = host
      ? join(
          process.env.XDG_STATE_HOME ??
            join(process.env.HOME ?? '/nonexistent', '.local/state'),
          'krn/context-gauge',
        )
      : join(input.project, '.krn/runs/claude/context-gauge');
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
      say(
        `Context at ${Math.floor(total / 1000)}k of ${Math.floor(window / 1000)}k, still past the handoff advisory. Stop the current step and ${handoff}; at ${Math.floor(ceiling / 1000)}k new work is refused.`,
      );
    } else if (level > highest) {
      const prefix = `Context at ${Math.floor(total / 1000)}k of ${Math.floor(window / 1000)}k.`;
      const finish = `Finish the current step, then ${handoff}.`;
      const exhausted = `Context budget nearly exhausted. Finish the current step now, then ${handoff} before starting any new work.`;
      // Jumping past both thresholds still delivers the first advisory.
      say(
        level === first
          ? `${prefix} ${finish}`
          : highest < first
            ? `${prefix} ${finish} ${exhausted}`
            : `${prefix} ${exhausted}`,
      );
    }
    if (notice) say('');
  } catch {
    /* Hooks fail open without adding misleading context. */
  }
}
