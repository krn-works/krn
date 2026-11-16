import { spawnSync } from 'node:child_process';
import { z } from 'zod';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Raw stdout for byte-exact Git blob comparisons. */
  stdoutBytes?: Buffer;
}
export type Runner = (
  command: string,
  args: string[],
  cwd: string,
  input?: string,
  timeoutMs?: number,
) => CommandResult;
export const run: Runner = (command, args, cwd, input, timeoutMs) => {
  const result = spawnSync(command, args, {
    cwd,
    input,
    timeout: timeoutMs ?? 3_600_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    code: result.status ?? 70,
    stdout: result.stdout?.toString('utf8') ?? '',
    stderr: result.stderr?.toString('utf8') || result.error?.message || '',
    stdoutBytes: result.stdout ?? Buffer.alloc(0),
  };
};
/** The JSON refusal a KRN receiver prints on stdout: `{"ok":false,"reason":"..."}`. */
export const refusalSchema = z.object({
  ok: z.literal(false),
  reason: z.string(),
});

export class CommandFailure extends Error {
  readonly result: CommandResult;
  readonly commandExitCode: number;
  readonly stdoutTail?: string;
  readonly firstFailingTest?: string;
  constructor(result: CommandResult) {
    const stdoutLines = result.stdout.split(/\r?\n/u).slice(-40).join('\n');
    const stdoutTail = Buffer.from(stdoutLines)
      .subarray(-8192)
      .toString('utf8');
    const failureText = `${result.stdout}\n${result.stderr}`;
    const first = failureText.match(/(?:not ok \d+ - |✖\s+)([^\r\n]+)/u)?.[1];
    let message = result.stderr || `command exited ${result.code}`;
    try {
      const refusal = refusalSchema.safeParse(JSON.parse(result.stdout));
      if (refusal.success) message = refusal.data.reason;
    } catch (error) {
      // Most failures print no JSON on stdout; only that parse error is expected.
      if (!(error instanceof SyntaxError)) throw error;
    }
    super(message);
    this.commandExitCode = result.code;
    this.result = result;
    if (stdoutTail) this.stdoutTail = stdoutTail;
    if (first) this.firstFailingTest = first;
  }
}
export function checked(result: CommandResult): string {
  if (result.code !== 0) throw new CommandFailure(result);
  return result.stdout.trim();
}
