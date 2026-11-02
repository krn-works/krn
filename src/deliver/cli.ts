import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CommandFailure, exitCodes } from './transport.ts';

export const help = `krn deliver --repo OWNER/REPO --pr N --record PATH (--message-file PATH | --task ID) [--dry-run] [--json]
  --load-threshold N  Deprecated; accepted and ignored (no host-load wait)
  --timeout-seconds N Bounded wait per stage (default 1800)
  --poll-ms N         Poll interval (default 10000)
Subject is the PR title (minus a trailing task suffix) followed by (#PR); .node-version must match Node on PATH.
Dry-run validates binding and merge contracts, then consults ship --dry-run without publishing or merging.
Resume from the main checkout with the same arguments after worktree retirement.
Exit codes: 0 delivered; 64 usage; 70 internal; ${Object.entries(exitCodes)
  .map(([name, code]) => `${code} ${name}`)
  .join('; ')}.
Stage failures preserve receiver stderr, stdoutTail and firstFailingTest when available, and expose its original exit code in JSON.
`;

type DeliveryCommandDependencies = {
  deliver?: typeof import('./delivery.ts').deliver;
};

export async function deliverCommand(
  args: string[],
  dependencies: DeliveryCommandDependencies = {},
): Promise<void> {
  let json = false;
  try {
    let values: { [key: string]: string | boolean | undefined };
    try {
      ({ values } = parseArgs({
        args,
        options: {
          repo: { type: 'string' },
          pr: { type: 'string' },
          record: { type: 'string' },
          task: { type: 'string' },
          'message-file': { type: 'string' },
          'dry-run': { type: 'boolean' },
          json: { type: 'boolean' },
          help: { type: 'boolean' },
          'load-threshold': { type: 'string' },
          'timeout-seconds': { type: 'string' },
          'poll-ms': { type: 'string' },
        },
      }));
    } catch (error) {
      throw Object.assign(
        error instanceof Error ? error : new Error(String(error)),
        { exitCode: 64 },
      );
    }
    if (values.help) {
      process.stdout.write(help);
      return;
    }
    json = values.json === true;
    const parsed = z
      .object({
        repo: z
          .string()
          .regex(/^[A-Za-z\d][A-Za-z\d_.-]*\/[A-Za-z\d][A-Za-z\d_.-]*$/u),
        pr: z.coerce.number().int().positive().safe(),
        record: z.string().min(1),
        task: z
          .string()
          .regex(/^t-[a-z\d]+$/u)
          .optional(),
        messageFile: z.string().min(1).optional(),
        dryRun: z.boolean(),
        loadThreshold: z.coerce.number().positive().finite(),
        timeoutMs: z.coerce.number().positive().finite(),
        pollMs: z.coerce.number().int().positive(),
      })
      .refine((value) => Boolean(value.task) !== Boolean(value.messageFile))
      .safeParse({
        repo: values.repo,
        pr: values.pr,
        record: values.record,
        task: values.task,
        messageFile: values['message-file'],
        dryRun: values['dry-run'] ?? false,
        loadThreshold: values['load-threshold'] ?? 6,
        timeoutMs: Number(values['timeout-seconds'] ?? 1800) * 1000,
        pollMs: values['poll-ms'] ?? 10000,
      });
    if (!parsed.success)
      throw Object.assign(new Error(`Invalid deliver arguments.\n${help}`), {
        exitCode: 64,
      });
    const { loadThreshold: _deprecatedLoadThreshold, ...options } = parsed.data;
    const result = dependencies.deliver
      ? await dependencies.deliver(options)
      : await (await import('./delivery.ts')).deliver(options);
    process.stdout.write(
      json
        ? `${JSON.stringify(result)}\n`
        : `${result.status}: ${result.head}\n`,
    );
  } catch (error) {
    const output = failureOutput(error, json);
    if (output.stdout) process.stdout.write(output.stdout);
    process.stderr.write(output.stderr);
    process.exitCode = output.exitCode;
  }
}

function failureOutput(error: unknown, json: boolean) {
  const exitCode =
    error instanceof Error &&
    'exitCode' in error &&
    typeof error.exitCode === 'number'
      ? error.exitCode
      : 70;
  const cause =
    error instanceof Error && 'cause' in error ? error.cause : error;
  const commandExitCode =
    cause instanceof CommandFailure ? cause.commandExitCode : undefined;
  const stdoutTail =
    cause instanceof CommandFailure ? cause.stdoutTail : undefined;
  const firstFailingTest =
    cause instanceof CommandFailure ? cause.firstFailingTest : undefined;
  const stdout = json
    ? `${JSON.stringify({ status: 'failed', exitCode, commandExitCode, ...(stdoutTail ? { stdoutTail } : {}), ...(firstFailingTest ? { firstFailingTest } : {}), error: error instanceof Error ? error.message : String(error) })}\n`
    : undefined;
  const stderr =
    cause instanceof CommandFailure
      ? cause.result.stderr || `${cause.message}\n`
      : `${error instanceof Error ? error.message : String(error)}\n`;
  return { exitCode, stdout, stderr };
}
