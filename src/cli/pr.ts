import { shipCommand, shipUsage } from '../ci/ship.ts';

export async function prCommand(args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (verb === 'ship') process.stdout.write(`${await shipCommand(rest)}\n`);
  else throw Object.assign(new Error(shipUsage), { exitCode: 64 });
}
