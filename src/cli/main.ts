#!/usr/bin/env node
import { commandErrorExitCode } from './command-error.ts';
import { commandHelp, topLevelHelp } from './help.ts';

const version = '0.1.0';

async function dispatch(args: string[]): Promise<boolean> {
  const { dispatch: run } = await import('./index.ts');
  return run(args);
}

// Removed commands fail like unknown ones, by name, and never reach another binary (KRN-06).
const retiredCommands: readonly string[] = [
  'review',
  'worker',
  'eval',
  'brain',
];

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

  if (
    [
      'ledger',
      'task',
      'ci',
      'pr',
      'doctor',
      'standards',
      'state',
      'lane',
      'decide',
      'adopt',
      'plan',
      'repo',
      'hook',
    ].includes(args[0] ?? '')
  ) {
    void dispatch(args).catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = commandErrorExitCode(error);
    });
    return;
  }

  const retired = retiredCommands.includes(args[0] ?? '');
  process.stderr.write(
    `krn: unknown command "${args[0]}"${retired ? ' (retired)' : ''}\nRun \`krn --help\` for the commands this CLI owns.\n`,
  );
  process.exitCode = 64;
}

if (import.meta.main) main();
