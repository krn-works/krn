import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { countStopRefusals, statesBlocker } from '../../brain/proof-line.ts';
import { configHome } from '../../harness/claude.ts';

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
  /** The Stop refusal the session met three times running with no edit between them (first line). */
  noProgress?: string;
  /** Stop refusals the session transcript shows. */
  stopRefusals?: number;
  /** The session's final result line when it starts with `BLOCKER:`. */
  blocker?: string;
}

export const exitNoDelivery = 74;
/** The session ended with a `BLOCKER:` line; the verdict prints it instead of the tree state. */
export const exitSessionBlocked = 73;
/** The session stopped at its spend cap (`--max-budget-usd`); the commit, if any, is not shipped. */
export const exitBudgetCapped = 75;

/** The session made no progress: three identical Stop refusals with no edit between them. */
export const exitNoProgress = 79;
/** Identical Stop refusals, with no edit between them, that end a lane. */
export const noProgressAttempts = 3;

const editTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const transcriptEventSchema = z.object({
  type: z.unknown(),
  subtype: z.unknown().optional(),
  hookErrors: z.array(z.string()).optional(),
  message: z
    .object({
      content: z
        .array(
          z.object({
            type: z.unknown(),
            name: z.unknown().optional(),
            input: z.unknown().optional(),
          }),
        )
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
});

/**
 * The refusal text repeated by the last `noProgressAttempts` Stop attempts of a transcript when the work tree
 * did not change between them (no Edit, Write, MultiEdit or NotebookEdit call with new input), else undefined.
 * The refusal text names the failing tests, so equal text is an equal failing-test set.
 */
export function repeatedStopRefusal(transcript: string): string | undefined {
  const attempts: { reason: string; edits: string }[] = [];
  let edits: string[] = [];
  for (const line of transcript.split('\n')) {
    if (line.trim() === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const event = transcriptEventSchema.safeParse(json);
    if (!event.success) continue;
    const { type, subtype, hookErrors, message } = event.data;
    if (type === 'system' && subtype === 'stop_hook_summary') {
      const reason = (hookErrors ?? [])
        .map((error) => error.replace(/^\[[^\]]*\]:\s*/u, '').trim())
        .filter((error) => error !== '')
        .join('\n');
      if (reason === '') continue;
      attempts.push({ reason, edits: edits.join('\n') });
      edits = [];
    } else if (type === 'assistant')
      for (const part of message?.content ?? [])
        if (part.type === 'tool_use' && editTools.has(String(part.name)))
          edits.push(JSON.stringify(part.input));
  }
  const last = attempts.slice(-noProgressAttempts);
  if (last.length < noProgressAttempts) return undefined;
  const [first] = last;
  const stuck = last.every(
    (attempt, index) =>
      attempt.reason === first?.reason && (index === 0 || attempt.edits === ''),
  );
  return stuck ? first?.reason : undefined;
}

/** The first line of the repeated refusal of a session transcript, found by session id; undefined when none. */
export function sessionNoProgress(sessionId: string): string | undefined {
  if (!/^[\w-]+$/u.test(sessionId)) return undefined;
  const projects = join(configHome(), 'projects');
  try {
    for (const directory of readdirSync(projects)) {
      const file = join(projects, directory, `${sessionId}.jsonl`);
      if (existsSync(file))
        return repeatedStopRefusal(readFileSync(file, 'utf8'))
          ?.split('\n')[0]
          ?.slice(0, 200);
    }
  } catch {
    // No transcript directory: no verdict.
  }
  return undefined;
}

/** The Stop refusals of a session, counted from its transcript by session id; undefined when none is found. */
export function sessionStopRefusals(sessionId: string): number | undefined {
  if (!/^[\w-]+$/u.test(sessionId)) return undefined;
  const projects = join(configHome(), 'projects');
  try {
    for (const directory of readdirSync(projects)) {
      const file = join(projects, directory, `${sessionId}.jsonl`);
      if (existsSync(file))
        return countStopRefusals(readFileSync(file, 'utf8'));
    }
  } catch {
    // No transcript directory: the count stays unknown.
  }
  return undefined;
}

/** The first `BLOCKER: <reason>` line of the session result: the line the Stop hook accepts as a way to end. */
export function blockerOf(text: unknown): { blocker?: string } {
  if (!statesBlocker(text)) return {};
  const line = (text as string)
    .split('\n')
    .map((candidate) =>
      candidate.trim().replace(/^\**BLOCKER:\**/u, 'BLOCKER:'),
    )
    .find((candidate) => /^BLOCKER:\s*\S/u.test(candidate));
  return line === undefined ? {} : { blocker: line.slice(0, 200) };
}

/** One line of a Claude session transcript (.jsonl under the Claude config directory). */
export const transcriptLineSchema = z.object({
  type: z.unknown(),
  message: z.object({ id: z.unknown() }).optional(),
});

/** Distinct assistant messages of a session transcript: one per model turn, however many lines a message spans. */
export function transcriptTurns(transcript: string): number {
  const ids = new Set<string>();
  for (const line of transcript.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = transcriptLineSchema.parse(JSON.parse(line));
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
  const projects = join(configHome(), 'projects');
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
  noProgressOf: (sessionId: string) => string | undefined = sessionNoProgress,
  refusalsOf: (sessionId: string) => number | undefined = sessionStopRefusals,
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
  const noProgress =
    failed && typeof record.session_id === 'string'
      ? noProgressOf(record.session_id)
      : undefined;
  const stopRefusals =
    typeof record.session_id === 'string'
      ? refusalsOf(record.session_id)
      : undefined;
  return {
    ok: !failed,
    detail: `session ${subtype}`,
    cost,
    ...(stopRefusals === undefined ? {} : { stopRefusals }),
    ...(noProgress === undefined ? {} : { noProgress }),
    ...(turns === undefined ? {} : { turns }),
    ...(subtype === 'error_max_budget_usd' ? { capped: true } : {}),
    ...blockerOf(record.result),
  };
}
