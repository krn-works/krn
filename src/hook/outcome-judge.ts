// The outcome arm of a lane Stop: a small model reads the task Outcome and Proof lines and the last turns of the transcript, and answers proven or missing with the missing item.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { claudeAgent } from '../harness/claude.ts';

/** The judge model. */
export const JUDGE_MODEL = 'claude-haiku-5-5';
/** The judge is given this long, then the Stop passes with a logged skip. */
export const JUDGE_TIMEOUT_MS = 60_000;
/** The log of every judge call and skip, one JSON line each, under the main checkout. */
export const JUDGE_LOG = '.krn/runs/outcome-judge.jsonl';
const TAIL_CHARS = 12_000;
const TAIL_ENTRIES = 12;

/** One judge call: the reply text and its cost, or the reason the judge was unavailable. */
export type JudgeReply =
  | { reply: string; costUsd: number }
  | { unavailable: string };
export type JudgeCall = (prompt: string, env: NodeJS.ProcessEnv) => JudgeReply;

/** The Outcome and Proof lines of a task body; undefined when it has no Outcome line. */
export function outcomeLines(
  body: string,
): { outcome: string; proof: string } | undefined {
  const line = (label: string) =>
    new RegExp(`^${label}:\\s*(.+)$`, 'mu').exec(body)?.[1]?.trim();
  const outcome = line('Outcome');
  return outcome === undefined
    ? undefined
    : { outcome, proof: line('Proof') ?? '' };
}

function entryText(raw: string): string {
  let entry: {
    type?: unknown;
    message?: { role?: unknown; content?: unknown };
  };
  try {
    entry = JSON.parse(raw);
  } catch {
    return '';
  }
  const role = entry.message?.role;
  if (role !== 'assistant' && role !== 'user') return '';
  const content = entry.message?.content;
  if (typeof content === 'string') return `${role}: ${content}`;
  if (!Array.isArray(content)) return '';
  const parts = content.flatMap((block: Record<string, unknown>) => {
    if (block.type === 'text' && typeof block.text === 'string')
      return [block.text];
    if (block.type === 'tool_use')
      return [`[tool ${String(block.name)} ${JSON.stringify(block.input)}]`];
    if (block.type === 'tool_result')
      return [`[result ${JSON.stringify(block.content)}]`];
    return [];
  });
  return parts.length > 0 ? `${role}: ${parts.join('\n')}` : '';
}

/** The last turns of a JSONL transcript as plain text, bounded in size; empty when unreadable. */
export function transcriptTail(path: string): string {
  if (!path || !existsSync(path)) return '';
  const entries = readFileSync(path, 'utf8')
    .split('\n')
    .map(entryText)
    .filter(Boolean)
    .slice(-TAIL_ENTRIES);
  return entries.join('\n\n').slice(-TAIL_CHARS);
}

/** The judge prompt: the task lines, the last turns, and the reply format. */
export function judgePrompt(
  lines: { outcome: string; proof: string },
  tail: string,
): string {
  return `You judge whether a work session delivered what its task promised. Answer from the transcript only.
Task Outcome: ${lines.outcome}
Task Proof: ${lines.proof || '(none stated)'}

Last turns of the session:
${tail}

Reply with exactly one line: "proven" when the transcript shows the Outcome delivered and the Proof produced, otherwise "missing: <the one item that is not shown>".`;
}

/** A verdict from the judge reply: proven, or missing with its item; undefined when the reply is neither. */
export function parseVerdict(
  reply: string,
): { proven: true } | { proven: false; item: string } | undefined {
  const match = /^\W*(proven|missing)\b[\s:;,.-]*(.*)$/imu.exec(reply.trim());
  if (!match) return undefined;
  return match[1]?.toLowerCase() === 'proven'
    ? { proven: true }
    : { proven: false, item: match[2]?.trim() || 'the task Outcome' };
}

/** The reply and cost in the JSON `claude -p --output-format json` prints. */
export function judgeReplyFrom(stdout: string): JudgeReply {
  try {
    const out = JSON.parse(stdout) as {
      result?: unknown;
      total_cost_usd?: unknown;
    };
    if (typeof out.result !== 'string')
      return { unavailable: 'judge gave no result' };
    return {
      reply: out.result,
      costUsd: typeof out.total_cost_usd === 'number' ? out.total_cost_usd : 0,
    };
  } catch {
    return { unavailable: 'judge output is not JSON' };
  }
}

/** The real judge: one headless Haiku call in a scratch directory with no hooks of the repository. */
export const claudeJudge: JudgeCall = (prompt, env) => {
  // A stand-in claude or a test run is never a real model call.
  if (env.KRN_LANE_CLAUDE || env.NODE_TEST_CONTEXT)
    return { unavailable: 'no real model in this environment' };
  const child = spawnSync(
    claudeAgent,
    [
      '-p',
      prompt,
      '--model',
      JUDGE_MODEL,
      '--output-format',
      'json',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--no-session-persistence',
      '--max-budget-usd',
      '0.25',
    ],
    {
      cwd: tmpdir(),
      encoding: 'utf8',
      timeout: JUDGE_TIMEOUT_MS,
      env: {
        ...env,
        KRN_OUTCOME_JUDGE: '0',
        CLAUDE_PROJECT_DIR: undefined,
        KRN_SESSION_CLASS: undefined,
      },
    },
  );
  if (child.error)
    return { unavailable: `judge unavailable: ${child.error.message}` };
  if (child.status !== 0) return { unavailable: `judge exit ${child.status}` };
  return judgeReplyFrom(child.stdout);
};

function logPath(root: string): string {
  const common = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout.trim();
  return join(dirname(resolve(root, common)), JUDGE_LOG);
}

function logged(root: string): Record<string, unknown>[] {
  try {
    const path = logPath(root);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function log(root: string, entry: Record<string, unknown>): void {
  try {
    const path = logPath(root);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    );
  } catch {
    /* The log is evidence, never a reason to fail a Stop. */
  }
}

/**
 * The refusal of the outcome arm, or undefined to let the Stop pass. It passes with a logged skip when the judge
 * is off (KRN_OUTCOME_JUDGE=0), the task has no Outcome line, the judge is unavailable, or it already refused this session once.
 */
export function outcomeRefusal(
  root: string,
  env: NodeJS.ProcessEnv,
  payload: unknown,
  body: string,
  judge: JudgeCall = claudeJudge,
): string | undefined {
  if (env.KRN_OUTCOME_JUDGE === '0') return undefined;
  const lines = outcomeLines(body);
  if (!lines) return undefined;
  const fields = payload as {
    session_id?: unknown;
    transcript_path?: unknown;
  } | null;
  const session =
    typeof fields?.session_id === 'string' ? fields.session_id : 'stop';
  const task = env.KRN_TASK ?? '';
  const tail = transcriptTail(
    typeof fields?.transcript_path === 'string' ? fields.transcript_path : '',
  );
  if (!tail) {
    log(root, { task, session, verdict: 'skip', reason: 'no transcript' });
    return undefined;
  }
  if (
    logged(root).some(
      (e) =>
        e.session === session && e.task === task && e.verdict === 'missing',
    )
  )
    return undefined;
  const answer = judge(judgePrompt(lines, tail), env);
  if ('unavailable' in answer) {
    log(root, { task, session, verdict: 'skip', reason: answer.unavailable });
    return undefined;
  }
  const verdict = parseVerdict(answer.reply);
  if (!verdict) {
    log(root, {
      task,
      session,
      verdict: 'skip',
      reason: 'unreadable reply',
      costUsd: answer.costUsd,
    });
    return undefined;
  }
  if (verdict.proven) {
    log(root, { task, session, verdict: 'proven', costUsd: answer.costUsd });
    return undefined;
  }
  log(root, {
    task,
    session,
    verdict: 'missing',
    item: verdict.item,
    costUsd: answer.costUsd,
  });
  return `Stop refused: the outcome judge found this missing from the task Outcome: ${verdict.item}\nDeliver it and show it, or end with a line \`BLOCKER: <what stops you>\`. This is refused once; KRN_OUTCOME_JUDGE=0 opts out.`;
}
