import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { object } from '../claude/context-io.ts';
import { restartText } from '../claude/context-restart.ts';

// Codex hook entry for a KRN lead: one process serves SessionStart (restart
// block), UserPromptSubmit and PostToolUse (usage advisories) and PreCompact
// (state-check receipt). Codex passes no project variable, so the project is
// the work tree of the payload's cwd, and only a work tree that adopted the KRN
// workflow gets anything. Every path fails open and never blocks Codex.

// KRN's advisory policy. The model window (475000 observed) is reported but
// does not set these: a lead hands off long before the window fills.
export const firstAdvisory = 120000;
export const secondAdvisory = 160000;
const outputLimit = 4096;

const managed = '<!-- krn-agent-workflow:start -->';

export type Reading = {
  total: number | undefined;
  window: number | undefined;
  boundary: string | undefined;
  reason: string | undefined;
};

// Context size is the LAST request's total (its input plus its answer, which
// is the next request's prefix). total_token_usage sums every request of the
// session (17.5M in one real rollout) and says nothing about the window.
export function codexReading(rollout: string): Reading {
  let total: number | undefined;
  let window: number | undefined;
  let boundary: string | undefined;
  let reason: string | undefined;
  for (const line of rollout.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = object(JSON.parse(line));
    } catch {
      continue; // The writer may still be appending the last line.
    }
    if (entry.type === 'compacted') {
      const id = object(entry.payload).window_id;
      boundary = typeof id === 'string' ? id : String(entry.timestamp);
      total = undefined;
      reason = undefined;
      continue;
    }
    if (entry.type !== 'event_msg') continue;
    const payload = object(entry.payload);
    if (payload.type !== 'token_count') continue;
    // The first token_count of a session carries rate limits and no usage.
    if (payload.info === null || payload.info === undefined) continue;
    const info = object(payload.info);
    const last = info.last_token_usage;
    const counter = last === undefined ? undefined : object(last).total_tokens;
    if (
      typeof counter !== 'number' ||
      !Number.isSafeInteger(counter) ||
      counter < 0
    ) {
      total = undefined;
      reason = 'invalid last_token_usage';
      continue;
    }
    total = counter;
    reason = undefined;
    if (Number.isSafeInteger(info.model_context_window))
      window = info.model_context_window as number;
  }
  return { total, window, boundary, reason };
}

function tail(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - 512 * 1024);
    const buffer = Buffer.alloc(size - start);
    const count = readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, count).toString('utf8');
    if (start === 0) return text;
    const newline = text.indexOf('\n');
    return newline < 0 ? '' : text.slice(newline + 1);
  } finally {
    closeSync(fd);
  }
}

function envelope(event: string, text: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: text },
  });
}

// Whole-envelope budget in bytes, with an explicit marker when text is cut, so
// a long block loses its tail instead of the whole restart context.
export function bounded(event: string, text: string): string {
  const size = (value: string) => Buffer.byteLength(envelope(event, value));
  if (size(text) <= outputLimit) return text;
  const marker = '\n[truncated: restart block exceeded the hook output limit]';
  let cut = text;
  while (cut.length > 0 && size(cut + marker) > outputLimit)
    cut = cut.slice(0, Math.max(0, cut.length - 64));
  return cut + marker;
}

function emit(event: string, text: string) {
  process.stdout.write(envelope(event, bounded(event, text)));
}

function git(project: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: project,
    encoding: 'utf8',
    timeout: 2000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function adopted(project: string): boolean {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      if (readFileSync(join(project, name), 'utf8').includes(managed))
        return true;
    } catch {
      /* A missing instruction file adopts nothing. */
    }
  }
  return false;
}

type State = {
  highest: number;
  boundary?: string | undefined;
  total?: number | undefined;
  down?: true | undefined;
};

function readState(path: string): State {
  if (!existsSync(path)) return { highest: 0 };
  const state = object(JSON.parse(readFileSync(path, 'utf8')));
  if (
    typeof state.highest !== 'number' ||
    !Number.isSafeInteger(state.highest) ||
    state.highest < 0
  )
    throw new Error('Invalid gauge state');
  return {
    highest: state.highest,
    boundary: typeof state.boundary === 'string' ? state.boundary : undefined,
    total: Number.isSafeInteger(state.total)
      ? (state.total as number)
      : undefined,
    down: state.down === true ? true : undefined,
  };
}

const kilo = (value: number) => `${Math.floor(value / 1000)}k`;

// The advisory text for one reading, or nothing; `state` is updated in place.
export function advisory(reading: Reading, state: State): string | undefined {
  const { total, window, boundary } = reading;
  if (total === undefined) {
    // Report an unreadable counter once, never as a small context.
    if (reading.reason === undefined || state.down) return undefined;
    state.down = true;
    return `Context gauge unavailable: ${reading.reason}. Judge context size yourself and run krn-handoff when unsure.`;
  }
  state.down = undefined;
  let highest = state.highest;
  // A compaction re-arms both advisories, and a large drop counts as one when
  // its marker has left the read window.
  if (
    (boundary !== undefined && boundary !== state.boundary) ||
    total < (state.total ?? 0) - 20000
  )
    highest = 0;
  const level =
    total >= secondAdvisory
      ? secondAdvisory
      : total >= firstAdvisory
        ? firstAdvisory
        : 0;
  state.boundary = boundary ?? state.boundary;
  state.total = total;
  state.highest = level === 0 ? 0 : Math.max(level, highest);
  if (level <= highest) return undefined;
  const prefix = `Context at ${kilo(total)} (KRN advisory ${kilo(firstAdvisory)}/${kilo(secondAdvisory)}${window === undefined ? '' : `; model window ${kilo(window)}`}).`;
  const finish = 'Finish the current step, then run krn-handoff.';
  const exhausted =
    'Context budget nearly exhausted. Finish the current step now, then run krn-handoff before starting any new work.';
  if (level === firstAdvisory) return `${prefix} ${finish}`;
  return highest < firstAdvisory
    ? `${prefix} ${finish} ${exhausted}`
    : `${prefix} ${exhausted}`;
}

function gauge(project: string, sessionId: string, transcript: string) {
  let reading: Reading;
  try {
    reading = codexReading(tail(transcript));
  } catch {
    reading = {
      total: undefined,
      window: undefined,
      boundary: undefined,
      reason: 'rollout unreadable',
    };
  }
  const directory = join(project, '.krn/runs/codex/context-gauge');
  const path = join(directory, `${sessionId}.json`);
  const state = readState(path);
  const text = advisory(reading, state);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  return text;
}

// A bounded receipt of the state a compaction starts from. It invents no
// capsule: restoration reads current files at the next SessionStart.
export function receipt(project: string, sessionId: string, now = new Date()) {
  const claims: string[] = [];
  let exit = 0;
  try {
    const directory = join(project, '.krn/task-claims');
    if (existsSync(directory))
      for (const name of readdirSync(directory).sort().slice(0, 20))
        if (name.endsWith('.json')) claims.push(name.slice(0, -5));
  } catch {
    exit = 1;
  }
  let head = '';
  try {
    head = git(project, ['rev-parse', '--short', 'HEAD']);
  } catch {
    exit = 1;
  }
  const directory = join(project, '.krn/runs/codex/precompact');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${sessionId}.json`),
    `${JSON.stringify({ at: now.toISOString(), head, claims, exit })}\n`,
    { mode: 0o600 },
  );
}

if (import.meta.main) {
  try {
    const input = object(JSON.parse(readFileSync(0, 'utf8')));
    const { session_id: sessionId, cwd, hook_event_name: event } = input;
    if (
      typeof sessionId !== 'string' ||
      !/^[a-zA-Z0-9_-]+$/u.test(sessionId) ||
      typeof cwd !== 'string' ||
      typeof event !== 'string'
    )
      throw new Error('Invalid hook input');
    const project = git(cwd, ['rev-parse', '--show-toplevel']);
    if (!adopted(project)) throw new Error('Not a KRN work tree');
    if (event === 'SessionStart') {
      if (
        !['startup', 'resume', 'clear', 'compact'].includes(
          String(input.source),
        )
      )
        throw new Error('Invalid source');
      emit(event, restartText(project, event));
    } else if (event === 'PreCompact') {
      receipt(project, sessionId);
    } else if (event === 'UserPromptSubmit' || event === 'PostToolUse') {
      if (typeof input.transcript_path !== 'string')
        throw new Error('Invalid hook input');
      const text = gauge(project, sessionId, input.transcript_path);
      if (text) emit(event, text);
    }
  } catch {
    /* Hooks fail open without adding misleading context. */
  }
}
