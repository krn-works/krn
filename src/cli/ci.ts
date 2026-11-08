import { logsCommand, logsUsage } from '../ci/logs.ts';
import { waitCommand, waitUsage } from '../ci/wait.ts';

export async function ciCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'wait')
    process.stdout.write(`${await waitCommand(rest)}\n`);
  else if (subcommand === 'logs')
    process.stdout.write(`${await logsCommand(rest)}\n`);
  else
    throw Object.assign(new Error(`${waitUsage}\n${logsUsage}`), {
      exitCode: 64,
    });
}
