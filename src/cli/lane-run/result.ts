import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const exitCredentialUnavailable = 69;
/** The contract install command failed in the lane worktree; no session started. */
export const exitInstallFailed = 71;
/** The contract test command is red on the clean base worktree; no session started. */
export const exitRedBaseline = 72;

export interface SessionResult {
  ok: boolean;
  detail: string;
  cost: number | undefined;
  turns?: number;
  /** The session ended at its spend cap. */
  capped?: boolean;
  /** The session's final result line when it starts with `BLOCKER:`. */
  blocker?: string;
}

export const exitNoDelivery = 74;
/** The session ended with a `BLOCKER:` line; the verdict prints it instead of the tree state. */
export const exitSessionBlocked = 73;
/** The session stopped at its spend cap (`--max-budget-usd`); the commit, if any, is not shipped. */
export const exitBudgetCapped = 75;

/** The final non-empty line of the session result text when it is a `BLOCKER:` line. */
export function blockerOf(text: unknown): { blocker?: string } {
  if (typeof text !== 'string') return {};
  const last = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .pop();
  return last?.startsWith('BLOCKER:') ? { blocker: last.slice(0, 200) } : {};
}

/** Distinct assistant messages of a session transcript: one per model turn, however many lines a message spans. */
export function transcriptTurns(transcript: string): number {
  const ids = new Set<string>();
  for (const line of transcript.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line) as {
        type?: unknown;
        message?: { id?: unknown };
      };
      if (entry.type === 'assistant' && typeof entry.message?.id === 'string')
        ids.add(entry.message.id);
    } catch {
      // A torn line is not a message.
    }
  }
  return ids.size;
}

/** The turn count of a session read from its transcript under the Claude config directory; undefined when none is found. */
export function sessionTurns(sessionId: string): number | undefined {
  if (!/^[\w-]+$/u.test(sessionId)) return undefined;
  const projects = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    'projects',
  );
  try {
    for (const directory of readdirSync(projects)) {
      const file = join(projects, directory, `${sessionId}.jsonl`);
      if (existsSync(file)) return transcriptTurns(readFileSync(file, 'utf8'));
    }
  } catch {
    // No transcript directory: the count stays unknown.
  }
  return undefined;
}

/** `num_turns` from `claude -p` is not a turn count (it printed 1 for a 22-message session), so the verdict counts the transcript or drops the field. */
export function parseSessionResult(
  stdout: string,
  stderr = '',
  turnsOf: (sessionId: string) => number | undefined = sessionTurns,
): SessionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const said = `${stderr}\n${stdout}`
      .trim()
      .split('\n')
      .slice(-3)
      .join(' | ');
    return {
      ok: false,
      detail: `session printed no JSON result (not a timeout)${said === '' ? '' : `: ${said.slice(0, 400)}`}`,
      cost: undefined,
    };
  }
  if (typeof parsed !== 'object' || parsed === null)
    return {
      ok: false,
      detail: 'session result is not an object',
      cost: undefined,
    };
  const record = parsed as Record<string, unknown>;
  const cost =
    typeof record.total_cost_usd === 'number'
      ? record.total_cost_usd
      : undefined;
  const subtype =
    typeof record.subtype === 'string' ? record.subtype : 'unknown';
  const failed = record.is_error === true || subtype !== 'success';
  const turns =
    typeof record.session_id === 'string'
      ? turnsOf(record.session_id)
      : undefined;
  return {
    ok: !failed,
    detail: `session ${subtype}`,
    cost,
    ...(turns === undefined ? {} : { turns }),
    ...(subtype === 'error_max_budget_usd' ? { capped: true } : {}),
    ...blockerOf(record.result),
  };
}
