import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
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
        'usage: krn slice run <task-id> --brief FILE --message FILE --name NAME --repo OWNER/REPO --model ID --effort LEVEL',
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
      },
      { root: process.cwd(), krn: resolve('bin/krn'), run },
    );
  } catch (error) {
    result = {
      stage: 'base',
      exitCode: 64,
      cause: oneLine(error instanceof Error ? error.message : String(error)),
    };
  }
  process.exitCode = result.exitCode;
  if (result.exitCode !== 0)
    process.stderr.write(
      `slice ${result.stage} exit=${result.exitCode}: ${oneLine(result.cause)}\n`,
    );
}
