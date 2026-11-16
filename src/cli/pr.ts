import { deployRemedy, deployWorkflows } from '../adopt/deploy.ts';
import { completeCloseExposure } from '../brain/close-exposure.ts';
import { shipCommand, shipUsage } from '../ci/ship.ts';
import { contractBase, contractDeployAcknowledged } from '../repo/contract.ts';
import { releaseClosedClaims } from '../task/claims.ts';
import { proofOfTitle } from './pr-body.ts';

/** The tracker-aware pieces `krn pr ship` runs with; `krn lane finish` ships through the same ones. */
export const cliShipRuntime: NonNullable<Parameters<typeof shipCommand>[1]> = {
  baseOf: contractBase,
  proofOf: proofOfTitle,
  completeClose: completeCloseExposure,
  releaseClaim: (main, worktree, task) => {
    releaseClosedClaims(main, worktree, task);
  },
  deployRefusal: (cwd, base) => {
    const files = deployWorkflows(cwd, base);
    return files.length > 0 && !contractDeployAcknowledged(cwd)
      ? deployRemedy(files, base)
      : undefined;
  },
};

export async function prCommand(args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (verb === 'ship')
    process.stdout.write(`${await shipCommand(rest, cliShipRuntime)}\n`);
  else if (verb === 'body') {
    const { prBodyCommand } = await import('./pr-body.ts');
    process.stdout.write(prBodyCommand(rest));
  } else throw Object.assign(new Error(shipUsage), { exitCode: 64 });
}
