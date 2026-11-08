import { waitUsage as usage, waitCommand } from '../ci/wait.ts';

export async function ciCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== 'wait')
    throw Object.assign(new Error(usage), { exitCode: 64 });
  process.stdout.write(`${await waitCommand(rest)}\n`);
}
