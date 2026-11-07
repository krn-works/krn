import { waitCommand } from '../ci/wait.ts';

const usage =
  'Usage: krn ci wait --repo <owner/repo> --pr <n> --head <sha> --base <sha> [--timeout-seconds <n>]';

export async function ciCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== 'wait')
    throw Object.assign(new Error(usage), { exitCode: 64 });
  process.stdout.write(`${await waitCommand(rest)}\n`);
}
