// One replay attempt as both harnesses see it: what its event stream shows (tool calls, test commands and their exit,
// stop reason), the verify-before-end gate every arm meets (a real lane cannot end without green tests; a replay arm
// gets the same rule as a harness-neutral check after the session, which re-prompts once with the failing output),
// and the attempt's verdict. Claude arms stream `claude -p --output-format stream-json`; Codex arms `codex exec --json`.

export type Harness = 'claude' | 'codex';

/** One test command the session ran, with its exit as the stream reports it. */
export interface TestRun {
  command: string;
  ok: boolean;
  output: string;
}

/** What one session's event stream shows. */
export interface StreamFacts {
  toolCalls: number;
  tests: TestRun[];
  /** Why the session ended: the model's own stop (`end_turn`), its spend cap, a failure, or unknown. */
  stopReason: string;
  /** The id a re-prompt resumes: Claude's session_id, Codex's thread_id. */
  sessionId?: string;
}

/**
 * A test command of any unit stack: Go, Node runners, Python, PHP, make and cargo. Matched on a command word boundary,
 * so `git commit -m "add test"` is not a test run.
 */
const TEST_COMMAND =
  /(^|[\s;&|('"])(go test|(npm|pnpm|yarn)( run)? test|npx( --no-install)? (vitest|jest|mocha)|vitest|jest|node --test|pytest|python3? -m (pytest|unittest)|\.venv\/bin\/(python -m )?pytest|phpunit|vendor\/bin\/phpunit|composer test|make test|cargo test|tox)\b/u;

export const isTestCommand = (command: string): boolean =>
  TEST_COMMAND.test(command);

const lines = (text: string): Record<string, unknown>[] =>
  text.split('\n').flatMap((l) => {
    if (l.trim() === '') return [];
    try {
      const v: unknown = JSON.parse(l);
      return typeof v === 'object' && v !== null && !Array.isArray(v)
        ? [v as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : arr(v)
        .map((p) => String(obj(p).text ?? ''))
        .join('\n');

/** Reads a `claude -p --output-format stream-json --verbose` stream. */
export function claudeFacts(stdout: string): StreamFacts {
  const events = lines(stdout);
  const commands = new Map<string, string>();
  let toolCalls = 0;
  const tests: TestRun[] = [];
  let stopReason = 'unknown';
  let sessionId: string | undefined;
  for (const e of events) {
    if (typeof e.session_id === 'string') sessionId = e.session_id;
    const content = arr(obj(e.message).content).map(obj);
    if (e.type === 'assistant')
      for (const part of content)
        if (part.type === 'tool_use') {
          toolCalls++;
          const command = obj(part.input).command;
          if (
            part.name === 'Bash' &&
            typeof command === 'string' &&
            typeof part.id === 'string'
          )
            commands.set(part.id, command);
        }
    if (e.type === 'user')
      for (const part of content) {
        const command = commands.get(String(part.tool_use_id));
        if (part.type === 'tool_result' && command && isTestCommand(command))
          tests.push({
            command,
            ok: part.is_error !== true,
            output: text(part.content),
          });
      }
    if (e.type === 'result') {
      const subtype = String(e.subtype ?? 'unknown');
      stopReason =
        subtype === 'success'
          ? String(e.stop_reason ?? 'end_turn')
          : subtype === 'error_max_budget_usd'
            ? 'budget'
            : subtype;
    }
  }
  return { toolCalls, tests, stopReason, ...(sessionId ? { sessionId } : {}) };
}

/** Reads a `codex exec --json` stream: every completed item but a message is a tool call. */
export function codexFacts(stdout: string): StreamFacts {
  let toolCalls = 0;
  const tests: TestRun[] = [];
  let stopReason = 'unknown';
  let sessionId: string | undefined;
  for (const e of lines(stdout)) {
    if (e.type === 'thread.started' && typeof e.thread_id === 'string')
      sessionId = e.thread_id;
    const item = obj(e.item);
    if (
      e.type === 'item.completed' &&
      item.type !== 'agent_message' &&
      item.type !== 'reasoning'
    ) {
      toolCalls++;
      if (
        item.type === 'command_execution' &&
        typeof item.command === 'string' &&
        isTestCommand(item.command)
      )
        tests.push({
          command: item.command,
          ok: item.exit_code === 0,
          output: String(item.aggregated_output ?? ''),
        });
    }
    if (e.type === 'turn.completed') stopReason = 'end_turn';
    if (e.type === 'turn.failed') stopReason = 'error';
  }
  return { toolCalls, tests, stopReason, ...(sessionId ? { sessionId } : {}) };
}

export const streamFacts = (harness: Harness, stdout: string): StreamFacts =>
  harness === 'codex' ? codexFacts(stdout) : claudeFacts(stdout);

/** Bytes of a failing test's output a re-prompt carries: its tail, where the failure is. */
const REPROMPT_OUTPUT = 4000;

/**
 * The verify-before-end gate every arm meets, harness-neutral: the session may end only when it ran a test command
 * and the last one passed. Returns the re-prompt for a session that may not end, else undefined.
 */
export function gateRefusal(facts: StreamFacts): string | undefined {
  const last = facts.tests.at(-1);
  if (last === undefined)
    return 'You ended without running any test. Before you finish, run the tests that cover your change (add one if none does), fix what fails, and end only when they pass.';
  if (last.ok) return undefined;
  return `You ended while your last test run failed:\n$ ${last.command}\n${last.output.slice(-REPROMPT_OUTPUT)}\nFix the failure and end only when the tests pass.`;
}

/** How one attempt ended for the report: graded, no attempt at all, or screened out before any session. */
export type Verdict = 'pass' | 'fail' | 'no-attempt' | 'not-run' | 'screened';

/**
 * The verdict of an attempt. A session that ran no test and changed nothing made no attempt: it is reported apart from
 * a fail, never counted as one.
 */
export function attemptVerdict(a: {
  ran: boolean;
  testsRun: number;
  changed: boolean;
  pass: boolean | undefined;
}): Verdict {
  if (!a.ran) return 'not-run';
  if (a.testsRun === 0 && !a.changed) return 'no-attempt';
  return a.pass === true ? 'pass' : 'fail';
}
