import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CommandFailure, exitCodes } from './transport.ts';

export const help = `krn deliver --repo OWNER/REPO --pr N --record PATH (--message-file PATH | --task ID) [--dry-run] [--json]
  --load-threshold N  Maximum 1-minute load (default 6)
  --timeout-seconds N Bounded wait per stage (default 1800)
  --poll-ms N         Poll interval (default 10000)
Dry-run validates binding and merge contracts without publishing or merging.
Resume from the main checkout with the same arguments after worktree retirement.
Exit codes: 0 delivered; 64 usage; 70 internal; ${Object.entries(exitCodes)
  .map(([name, code]) => `${code} ${name}`)
  .join('; ')}.
Stage failures preserve receiver stderr and expose its original exit code in JSON.
`;

export async function deliverCommand(args: string[]): Promise<void> {
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
    const { deliver } = await import('./delivery.ts');
    const result = await deliver(parsed.data);
    process.stdout.write(
      json
        ? `${JSON.stringify(result)}\n`
        : `${result.status}: ${result.head}\n`,
    );
  } catch (error) {
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
    if (json)
      process.stdout.write(
        `${JSON.stringify({ status: 'failed', exitCode, commandExitCode, error: error instanceof Error ? error.message : String(error) })}\n`,
      );
    process.stderr.write(
      cause instanceof CommandFailure
        ? cause.result.stderr
        : `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = exitCode;
  }
}
