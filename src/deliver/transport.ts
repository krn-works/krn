import { spawnSync } from 'node:child_process';

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
export const exitCodes = {
  bind: 71,
  statuses: 72,
  message: 73,
  ci: 74,
  'ci-wait': 75,
  ship: 76,
  hygiene: 77,
} as const;

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
      const refusal = JSON.parse(result.stdout);
      if (refusal?.ok === false && typeof refusal.reason === 'string')
        message = refusal.reason;
    } catch {}
    super(message);
    this.commandExitCode = result.code;
    this.result = result;
    if (stdoutTail) this.stdoutTail = stdoutTail;
    if (first) this.firstFailingTest = first;
  }
}
export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** GitHub answers in about 1 s but sometimes stalls on connect; cut and retry. */
export const GH_CALL_TIMEOUT_MS = 10_000;
/** Log download streams a whole job log, so it legitimately runs longer. */
export const GH_LOG_TIMEOUT_MS = 120_000;
const ghTimeout = (args: string[]) =>
  args.some((arg) => /^--log(?:-failed)?$/u.test(arg))
    ? GH_LOG_TIMEOUT_MS
    : GH_CALL_TIMEOUT_MS;

/** Only this boundary invokes gh. Keep the last receiver failure intact. */
export async function github(
  args: string[],
  cwd: string,
  runner: Runner = run,
  wait = sleep,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const result = runner('gh', args, cwd, undefined, ghTimeout(args));
    if (result.code === 0) return result.stdout;
    const transient =
      /(?:HTTP\s+(?:5\d\d|429)\b|rate limit|secondary rate|could not resolve host|temporary failure in name resolution|EAI_AGAIN|ENOTFOUND|ECONNRESET|ETIMEDOUT|connection (?:reset|refused)|TLS handshake timeout|network is unreachable|unexpected EOF|error connecting to)/iu.test(
        result.stderr,
      );
    if (!transient || attempt === 3) throw new CommandFailure(result);
    await wait(1000 * 2 ** attempt);
  }
}
export function checked(result: CommandResult): string {
  if (result.code !== 0) throw new CommandFailure(result);
  return result.stdout.trim();
}
