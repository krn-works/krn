// Codex stream events are untrusted input; only validated token counts enter
// session totals, while each turn's original usage stays in the call ledger.
//
// Receiver semantics of codex-cli 0.167.0, verified by the verbatim captures in
// test/fixtures/eval/codex-0.167.0 (sources listed in its provenance.json):
// - exec ends after one terminal turn; turn.completed carries the thread's
//   total usage and turn.failed carries none, so only a stream whose single
//   turn completed has accountable usage;
// - a top-level error is a diagnostic, emitted per retry ("Reconnecting...")
//   and before turn.failed; failure is turn.failed or a non-zero exit;
// - an ignored or unrecognised setting arrives as an item.completed error item.
type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

const fields = [
  'input_tokens',
  'output_tokens',
  'cached_input_tokens',
  'reasoning_output_tokens',
] as const;

// The ConfigWarning summary Codex prints for settings it drops.
const ignoredSetting =
  /^Codex is ignoring \d+ unrecognized configuration settings?\./u;

type SessionStatus =
  | 'completed'
  | 'truncated'
  | 'timeout'
  | 'agent_error'
  | 'harness_error';

export class SessionUsage {
  readonly calls: { index: number; kind: string; usage: unknown }[] = [];
  private readonly decoder = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  });
  private pending = '';
  private invalid = false;
  private invalidUsage = false;
  private terminal = false;
  private activeTurn: number | undefined;
  turnStarted = false;
  toolCalled = false;
  failed = false;
  configRejected = false;

  push(bytes: Buffer): void {
    try {
      this.pending += this.decoder.decode(bytes, { stream: true });
      let newline = this.pending.indexOf('\n');
      while (newline !== -1) {
        this.event(this.pending.slice(0, newline).replace(/\r$/u, ''));
        this.pending = this.pending.slice(newline + 1);
        newline = this.pending.indexOf('\n');
      }
    } catch {
      this.invalid = true;
    }
  }

  finish(): void {
    try {
      this.pending += this.decoder.decode();
    } catch {
      this.invalid = true;
    }
    if (this.pending !== '') this.event(this.pending.replace(/\r$/u, ''));
  }

  get truncated(): boolean {
    return this.invalid || !this.terminal;
  }

  private validUsage(value: unknown): boolean {
    const usage = record(value);
    if (
      !fields.every(
        (field) =>
          typeof usage[field] === 'number' &&
          Number.isSafeInteger(usage[field]) &&
          usage[field] >= 0,
      )
    )
      return false;
    const input = usage.input_tokens,
      output = usage.output_tokens;
    const cached = usage.cached_input_tokens,
      reasoning = usage.reasoning_output_tokens;
    if (
      typeof input !== 'number' ||
      typeof output !== 'number' ||
      typeof cached !== 'number' ||
      typeof reasoning !== 'number'
    )
      return false;
    return cached <= input && reasoning <= output;
  }

  private event(line: string): void {
    let event: RecordValue;
    try {
      event = record(JSON.parse(line));
    } catch {
      this.invalid = true;
      return;
    }
    if (typeof event.type !== 'string') {
      this.invalid = true;
      return;
    }
    if (event.type === 'turn.started') {
      this.terminal = false;
      this.turnStarted = true;
      if (this.activeTurn !== undefined) this.invalid = true;
      this.activeTurn = this.calls.length;
      this.calls.push({
        index: this.calls.length + 1,
        kind: 'turn.started',
        usage: null,
      });
    }
    const item = record(event.item);
    if (
      [
        'command_execution',
        'mcp_tool_call',
        'web_search',
        'file_change',
      ].includes(String(item.type))
    )
      this.toolCalled = true;
    if (
      event.type === 'item.completed' &&
      item.type === 'error' &&
      typeof item.message === 'string' &&
      ignoredSetting.test(item.message)
    )
      this.configRejected = true;
    if (event.type === 'turn.failed') this.failed = true;
    if (event.type === 'turn.failed' || event.type === 'turn.completed') {
      this.terminal = true;
      if (event.type === 'turn.completed' && !this.validUsage(event.usage))
        this.invalidUsage = true;
      const call =
        this.activeTurn === undefined ? undefined : this.calls[this.activeTurn];
      if (call) {
        call.kind = event.type;
        call.usage = event.usage ?? null;
      } else
        this.calls.push({
          index: this.calls.length + 1,
          kind: event.type,
          usage: event.usage ?? null,
        });
      this.activeTurn = undefined;
    }
  }

  summary(interrupted: boolean) {
    const missing = () => ({
      status: 'missing' as const,
      total_tokens: null,
    });
    const [call, ...later] = this.calls;
    if (
      interrupted ||
      this.truncated ||
      this.invalidUsage ||
      call?.kind !== 'turn.completed' ||
      later.length > 0
    )
      return missing();
    const usage = record(call.usage);
    const totals: Record<string, number> = {};
    for (const field of fields) {
      const value = usage[field];
      if (typeof value !== 'number') return missing();
      totals[field] = value;
    }
    // Cached and reasoning tokens are subsets of Codex input and output.
    const total = (totals.input_tokens ?? 0) + (totals.output_tokens ?? 0);
    if (!Number.isSafeInteger(total)) return missing();
    return {
      status: 'complete' as const,
      ...totals,
      total_tokens: total,
    };
  }

  status(run: {
    exitCode: number;
    timedOut: boolean;
    launchError: boolean;
  }): SessionStatus {
    if (this.configRejected) return 'harness_error';
    if (run.timedOut) return 'timeout';
    if (run.launchError) return 'harness_error';
    if (run.exitCode !== 0 || this.failed)
      // Without a turn the agent never ran: the mask exits 70 and Codex exits 1
      // before their first turn. A turn that failed before any tool call is a
      // provider, login or model failure.
      return !this.turnStarted ||
        (run.exitCode !== 0 && this.failed && !this.toolCalled)
        ? 'harness_error'
        : 'agent_error';
    return this.truncated ? 'truncated' : 'completed';
  }
}
