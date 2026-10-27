// Harness events are untrusted input. Keep their usage payloads verbatim in the
// call ledger; only validated nonnegative safe integers enter session totals.
export type Harness = 'codex' | 'claude';
type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

const fields = {
  codex: [
    'input_tokens',
    'output_tokens',
    'cached_input_tokens',
    'reasoning_output_tokens',
  ],
  claude: [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
  ],
} as const;

export class SessionUsage {
  readonly calls: {
    index: number;
    kind: string;
    messageId?: string;
    usage: unknown;
  }[] = [];
  private readonly messages = new Map<string, number>();
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
  private result: { usage: unknown; modelUsage: unknown } | undefined;

  private readonly harness: Harness;

  constructor(harness: Harness) {
    this.harness = harness;
  }

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
      !fields[this.harness].every(
        (field) =>
          typeof usage[field] === 'number' &&
          Number.isSafeInteger(usage[field]) &&
          usage[field] >= 0,
      )
    )
      return false;
    if (this.harness === 'codex') {
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
    return true;
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
    if (this.harness === 'codex') {
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
        /\b(?:config(?:uration)?|settings?|features?)\b/iu.test(
          event.message,
        ) &&
        /\b(?:ignored|unrecogni[sz]ed)\b/iu.test(event.message)
      )
        this.configRejected = true;
      if (event.type === 'turn.failed' || event.type === 'turn.completed') {
        this.terminal = true;
        if (!this.validUsage(event.usage)) this.invalidUsage = true;
        const call =
          this.activeTurn === undefined
            ? undefined
            : this.calls[this.activeTurn];
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
    } else {
      if (event.type === 'assistant') {
        this.terminal = false;
        const message = record(event.message);
        if (
          Array.isArray(message.content) &&
          message.content.some((block) => record(block).type === 'tool_use')
        )
          this.toolCalled = true;
        if (!this.validUsage(message.usage)) this.invalidUsage = true;
        if (typeof message.id !== 'string' || message.id.trim() === '') {
          this.invalidUsage = true;
          return;
        }
        const prior = this.messages.get(message.id);
        if (prior !== undefined) {
          const call = this.calls[prior];
          if (call) call.usage = message.usage ?? null;
        } else {
          this.messages.set(message.id, this.calls.length);
          this.calls.push({
            index: this.calls.length + 1,
            kind: 'assistant',
            messageId: message.id,
            usage: message.usage ?? null,
          });
        }
      }
      if (event.type === 'result') {
        this.terminal = true;
        if (!this.validUsage(event.usage)) this.invalidUsage = true;
        this.error =
          event.is_error === true ||
          (typeof event.subtype === 'string' && event.subtype !== 'success');
        this.result = {
          usage: event.usage ?? null,
          modelUsage: event.modelUsage ?? null,
        };
      }
      if (event.type === 'error') this.error = true;
    }
  }

  summary(interrupted: boolean) {
    const crossCheck = this.result ? { result: this.result } : {};
    const missing = () => ({
      status: 'missing' as const,
      total_tokens: null,
      ...crossCheck,
    });
    if (
      interrupted ||
      this.truncated ||
      this.invalidUsage ||
      this.calls.length === 0
    )
      return missing();
    const totals: Record<string, number> = {};
    for (const field of fields[this.harness]) totals[field] = 0;
    for (const call of this.calls) {
      const usage = record(call.usage);
      for (const field of fields[this.harness]) {
        const value = usage[field];
        if (typeof value !== 'number') return missing();
        const total = (totals[field] ?? 0) + value;
        if (!Number.isSafeInteger(total)) return missing();
        totals[field] = total;
      }
    }
    // Cached/reasoning are subsets for Codex; Claude reports caches separately.
    const total =
      (totals.input_tokens ?? 0) +
      (totals.output_tokens ?? 0) +
      (this.harness === 'claude'
        ? (totals.cache_read_input_tokens ?? 0) +
          (totals.cache_creation_input_tokens ?? 0)
        : 0);
    if (!Number.isSafeInteger(total)) return missing();
    return {
      status: 'complete' as const,
      ...totals,
      total_tokens: total,
      ...crossCheck,
    };
  }
}
