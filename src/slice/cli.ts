import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runSlice, type SliceResult, type SliceRuntime } from './run.ts';
import { oneLine } from './stages.ts';

const run: SliceRuntime['run'] = (command, args, { cwd }) =>
  new Promise((done) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      stdout += text;
    });
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr += text;
      process.stderr.write(text);
    });
    child.once('error', () =>
      done({ code: 127, stdout, stderr: 'cannot start command' }),
    );
    child.once('close', (code) => done({ code: code ?? 128, stdout, stderr }));
  });

/** Open landing outputs without following an existing symlink, then hand descriptors to the child. */
export const detach: SliceRuntime['detach'] = (command, args, { cwd, log }) =>
  new Promise<void>((started, failed) => {
    const output = openSync(
      log,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_APPEND |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const exitPath = join(dirname(log), 'landing.exit');
      const temporary = join(dirname(log), `.landing-${randomUUID()}.tmp`);
      const exit = openSync(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const child = spawn(
          '/bin/sh',
          [
            '-c',
            // One landing per run directory: a restart that finds the lock held or the exit published stops.
            'target=$1; temporary=$2; lock=$3; shift 3; exec 9>>"$lock"; if { command -v flock >/dev/null && ! flock -n 9; } || [ -e "$target" ]; then rm -f -- "$temporary"; exit 0; fi; "$@" >&3 2>&1 9>&-; echo $? >&4; mv -T -- "$temporary" "$target"',
            'landing',
            exitPath,
            temporary,
            join(dirname(log), 'landing.lock'),
            command,
            ...args,
          ],
          {
            cwd,
            detached: true,
            stdio: ['ignore', 'ignore', 'ignore', output, exit],
          },
        );
        // Resolve only once the process exists; a start error reaches the slice run.
        child.once('spawn', () => {
          child.unref();
          started();
        });
        child.once('error', failed);
      } finally {
        closeSync(exit);
      }
    } catch (error) {
      failed(error);
    } finally {
      closeSync(output);
    }
  });

export async function sliceCommand(args: readonly string[]): Promise<void> {
  let result: SliceResult;
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        brief: { type: 'string' },
        message: { type: 'string' },
        name: { type: 'string' },
        repo: { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string' },
        worker: { type: 'string' },
        'stop-after': { type: 'string' },
        override: { type: 'boolean' },
        reason: { type: 'string' },
        evidence: { type: 'string' },
      },
    });
    if (
      positionals.length !== 2 ||
      positionals[0] !== 'run' ||
      (values.worker !== undefined &&
        values.worker !== 'codex' &&
        values.worker !== 'none')
    )
      throw new Error(
        'usage: krn slice run <task-id> --brief FILE --message FILE --name NAME --repo OWNER/REPO --model ID --effort LEVEL [--worker codex|none] [--stop-after STAGE] [--override --reason TEXT --evidence TEXT]',
      );
    result = await runSlice(
      {
        task: positionals[1] ?? '',
        brief: values.brief ?? '',
        message: values.message ?? '',
        name: values.name ?? '',
        repo: values.repo ?? '',
        model: values.model ?? '',
        effort: values.effort ?? '',
        ...(values.worker === undefined ? {} : { worker: values.worker }),
        ...(values['stop-after'] === undefined
          ? {}
          : { stopAfter: values['stop-after'] }),
        ...(values.override === true ? { override: true } : {}),
        ...(values.reason === undefined ? {} : { reason: values.reason }),
        ...(values.evidence === undefined ? {} : { evidence: values.evidence }),
      },
      { root: process.cwd(), krn: resolve('bin/krn'), run, detach },
    );
  } catch (error) {
    result = {
      stage: 'base',
      exitCode: 64,
      cause: oneLine(error instanceof Error ? error.message : String(error)),
    };
  }
  process.exitCode = result.exitCode;
  if (result.exitCode === 0 && result.cause)
    process.stdout.write(`${result.cause}\n`);
  if (result.exitCode !== 0) process.stderr.write(failureText(result));
}

/** The stderr text of a failed slice run: the cause line, then one indented line per detail; details keep their length so a record path is never cut. */
export function failureText(result: SliceResult): string {
  const cause =
    result.stage === 'gate' || result.stage === 'done'
      ? (result.cause.split(/[\n\r\u2028\u2029]/u)[0] ?? '').replace(
          /[\p{Cc}\p{Cf}]/gu,
          '',
        )
      : oneLine(result.cause);
  return `slice ${result.stage} exit=${result.exitCode}: ${cause}\n${(
    result.details ?? []
  )
    .map(
      (detail) => `  ${detail.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ')}\n`,
    )
    .join('')}`;
}
