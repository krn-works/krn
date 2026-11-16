import { logsCommand, logsUsage } from '../ci/logs.ts';

export async function ciCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'logs')
    process.stdout.write(`${await logsCommand(rest)}\n`);
  else throw Object.assign(new Error(logsUsage), { exitCode: 64 });
}
