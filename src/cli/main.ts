#!/usr/bin/env node
// The CLI owns its name while unknown commands pass through to the configured legacy entry. ADR 0001.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { commandErrorExitCode } from './command-error.ts';

const version = '0.1.0';
const recursionFlag = 'KRN_FORWARDED';
const entryFile = import.meta.filename;
type ReviewCommandOutcome =
  | 'PASS'
  | 'FAIL'
  | 'INCOMPLETE'
  | 'OVERRIDE'
  | 'PREPASS_BLOCKING';

async function dispatch(
  args: string[],
  runtime: { readonly delegate?: import('./delegate.ts').DelegateRuntime } = {},
): Promise<boolean> {
  const { dispatch: run } = await import('./index.ts');
  return run(args, runtime);
}

async function review(args: string[]): Promise<void> {
  const { reviewCommand } = await import('../flow/cli.ts');
  const outcome = await reviewCommand(args);
  if (outcome) process.exitCode = reviewOutcomeExitCode(outcome);
}

async function reportJourney(args: string[]): Promise<void> {
  const { reportJourneyCommand } = await import('./report-journey.ts');
  process.exitCode = reportJourneyCommand(args);
}

async function forward(args: string[]): Promise<void> {
  if (process.env[recursionFlag] === '1') {
    process.stderr.write('Legacy forwarding recursion blocked.\n');
    process.exitCode = 70;
    return;
  }

  let legacyBin = process.env.KRN_LEGACY_ENTRY;
  if (!legacyBin) {
    const [operatingSystem, path] = await Promise.all([
      import('node:os'),
      import('node:path'),
    ]);
    legacyBin = path.join(
      operatingSystem.homedir(),
      '.codex/krn/current/scripts/krn.mjs',
    );
  }
  let resolvesToEntry: boolean;
  try {
    resolvesToEntry = realpathSync(legacyBin) === entryFile;
  } catch {
    const { resolve } = await import('node:path');
    resolvesToEntry = resolve(legacyBin) === entryFile;
  }
  if (resolvesToEntry) {
    process.stderr.write('Legacy forwarding recursion blocked.\n');
    process.exitCode = 70;
    return;
  }

  const child = spawn(process.execPath, [legacyBin, ...args], {
    env: { ...process.env, [recursionFlag]: '1' },
    stdio: 'inherit',
  });
  child.once('error', () => {
    process.stderr.write(`Unable to start legacy command: ${legacyBin}\n`);
    process.exitCode = 127;
  });
  child.once('close', (code, signal) => {
    if (code !== null) process.exitCode = code;
    else if (signal) process.exitCode = 128;
    else process.exitCode ??= 1;
  });
}

export function reviewOutcomeExitCode(outcome: ReviewCommandOutcome): number {
  switch (outcome) {
    case 'PASS':
    case 'OVERRIDE':
      return 0;
    case 'FAIL':
      return 1;
    case 'INCOMPLETE':
      return 2;
    case 'PREPASS_BLOCKING':
      return 3;
  }
}

export function reviewErrorExitCode(error: unknown): number {
  return error instanceof Error && error.name === 'ReviewUsageError' ? 64 : 70;
}

export function main(args = process.argv.slice(2)): void {
  if (args[0] === '--version') {
    process.stdout.write(`krn ${version}\n`);
    return;
  }

  if (args[0] === 'review') {
    void review(args.slice(1)).catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = reviewErrorExitCode(error);
    });
    return;
  }

  if (args[0] === 'report' && args[1] === 'journey') {
    void reportJourney(args.slice(1));
    return;
  }

  if (args[0] === 'delegate') {
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    void dispatch(args, {
      delegate: {
        signal: controller.signal,
        setExitCode: (code) => {
          process.exitCode = code;
        },
      },
    })
      .catch((error: unknown) => {
        process.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = controller.signal.aborted
          ? 130
          : commandErrorExitCode(error);
      })
      .finally(() => {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
      });
    return;
  }

  if (['start', 'checkpoint', 'stop', 'note', 'task'].includes(args[0] ?? '')) {
    void dispatch(args).catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = commandErrorExitCode(error);
    });
    return;
  }

  void forward(args);
}

if (import.meta.main) main();
