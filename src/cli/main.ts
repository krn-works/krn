#!/usr/bin/env node
import { commandErrorExitCode } from './command-error.ts';
import { commandHelp, topLevelHelp } from './help.ts';

const version = '0.1.0';
type ReviewCommandOutcome =
  | 'PASS'
  | 'FAIL'
  | 'INCOMPLETE'
  | 'OVERRIDE'
  | 'PREPASS_BLOCKING';

async function dispatch(args: string[]): Promise<boolean> {
  const { dispatch: run } = await import('./index.ts');
  return run(args);
}

async function review(args: string[]): Promise<void> {
  const { reviewCommand } = await import('../flow/cli.ts');
  const outcome = await reviewCommand(args);
  if (outcome) process.exitCode = reviewOutcomeExitCode(outcome);
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
  const help = commandHelp(args);
  if (help !== undefined) {
    process.stdout.write(help);
    return;
  }
  if (args[0] === '--help' || args[0] === '-h' || args.length === 0) {
    process.stdout.write(topLevelHelp());
    return;
  }

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

  if (['ledger', 'task', 'worker', 'eval', 'ci'].includes(args[0] ?? '')) {
    void dispatch(args).catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = commandErrorExitCode(error);
    });
    return;
  }

  process.stderr.write(
    `krn: unknown command "${args[0]}"\nRun \`krn --help\` for the commands this CLI owns.\n`,
  );
  process.exitCode = 64;
}

if (import.meta.main) main();
