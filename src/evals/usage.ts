// Codex stream events are untrusted input; only validated token counts enter
// session totals, while each turn's original usage stays in the call ledger.
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
  toolCalled = false;
  error = false;
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
    if (event.type === 'error' || event.type === 'turn.failed')
      this.error = true;
    if (
      event.type === 'error' &&
      typeof event.message === 'string' &&
      /\b(?:config(?:uration)?|settings?|features?)\b/iu.test(event.message) &&
      /\b(?:ignored|unrecogni[sz]ed)\b/iu.test(event.message)
    )
      this.configRejected = true;
    if (event.type === 'turn.failed' || event.type === 'turn.completed') {
      this.terminal = true;
      if (!this.validUsage(event.usage)) this.invalidUsage = true;
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
    if (
      interrupted ||
      this.truncated ||
      this.invalidUsage ||
      this.calls.length === 0
    )
      return missing();
    const totals: Record<string, number> = {};
    for (const field of fields) totals[field] = 0;
    for (const call of this.calls) {
      const usage = record(call.usage);
      for (const field of fields) {
        const value = usage[field];
        if (typeof value !== 'number') return missing();
        const total = (totals[field] ?? 0) + value;
        if (!Number.isSafeInteger(total)) return missing();
        totals[field] = total;
      }
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
}
