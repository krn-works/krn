import { resolve } from 'node:path';
import { deployRemedy, deployWorkflows } from '../adopt/deploy.ts';
import { completeCloseExposure } from '../brain/close-exposure.ts';
import { type Runner, run } from '../ci/command.ts';
import { shipCommand, shipUsage } from '../ci/ship.ts';
import { startDetachedShip } from '../ci/ship-live.ts';
import { contractBase, contractDeployAcknowledged } from '../repo/contract.ts';
import { releaseClosedClaims } from '../task/claims.ts';
import { outsideCredentialArgs } from './outside-git.ts';
import { proofOfTitle } from './pr-body.ts';

/**
 * A runner whose git calls carry the origin's App credential helper when the origin is an outside repository: the
 * host's default credential reaches only the product repository, so a pilot push failed "Repository not found"
 * (2026-11-17). Resolved once per directory.
 */
export function outsideRunner(
  base: Runner = run,
  credentialsOf: (cwd: string) => string[] = (cwd) =>
    outsideCredentialArgs(cwd),
): Runner {
  const known = new Map<string, string[]>();
  return (command, args, cwd, ...rest) => {
    if (command !== 'git') return base(command, args, cwd, ...rest);
    let credentials = known.get(cwd);
    if (credentials === undefined) {
      credentials = credentialsOf(cwd);
      known.set(cwd, credentials);
    }
    return base(command, [...credentials, ...args], cwd, ...rest);
  };
}

/** The tracker-aware pieces `krn pr ship` runs with; `krn lane finish` ships through the same ones. */
export const cliShipRuntime: NonNullable<Parameters<typeof shipCommand>[1]> = {
  run: outsideRunner(),
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
  if (verb === 'ship' && rest.includes('--detach')) {
    const args = rest.filter((arg) => arg !== '--detach');
    const at = args.indexOf('--worktree');
    const worktree = resolve(at >= 0 ? (args[at + 1] ?? '.') : '.');
    const started = startDetachedShip(worktree, [
      ...process.execArgv,
      ...process.argv.slice(1, 2),
      'pr',
      'ship',
      ...args,
    ]);
    process.stdout.write(
      `ship detached: pid ${started.pid}, log ${started.log}; \`krn lane status\` shows whether it is live, merged or orphaned\n`,
    );
  } else if (verb === 'ship')
    process.stdout.write(`${await shipCommand(rest, cliShipRuntime)}\n`);
  else if (verb === 'body') {
    const { prBodyCommand } = await import('./pr-body.ts');
    process.stdout.write(prBodyCommand(rest));
  } else throw Object.assign(new Error(shipUsage), { exitCode: 64 });
}
