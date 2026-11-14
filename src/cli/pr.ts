import { shipCommand, shipUsage } from '../ci/ship.ts';
import { contractBase } from '../repo/contract.ts';
import { proofOfTitle } from './pr-body.ts';

export async function prCommand(args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (verb === 'ship')
    process.stdout.write(
      `${await shipCommand(rest, { baseOf: contractBase, proofOf: proofOfTitle })}\n`,
    );
  else if (verb === 'body') {
    const { prBodyCommand } = await import('./pr-body.ts');
    process.stdout.write(prBodyCommand(rest));
  } else throw Object.assign(new Error(shipUsage), { exitCode: 64 });
}
