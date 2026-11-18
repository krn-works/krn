import { resolve } from 'node:path';
import { deployRemedy, deployWorkflows } from '../adopt/deploy.ts';
import { completeCloseExposure } from '../brain/close-exposure.ts';
import { type Runner, run } from '../ci/command.ts';
import { shipCommand, shipUsage } from '../ci/ship.ts';
import { startDetachedShip } from '../ci/ship-live.ts';
import { contractBase, contractDeployAcknowledged } from '../repo/contract.ts';
import { rootRepository } from '../repo/gh.ts';
import { releaseClosedClaims } from '../task/claims.ts';
import { outsideCredentialArgs, productRepository } from './outside-git.ts';
import { kindOfTitle, proofOfTitle } from './pr-body.ts';

/**
 * A runner whose git calls carry the origin's App credential helper when the origin is an outside repository: the
 * host's default credential reaches only the product repository, so a pilot push failed "Repository not found"
 * (2026-11-17). Its gh calls are scoped to that origin too. Resolved once per directory.
 */
export function outsideRunner(
  base: Runner = run,
  credentialsOf: (cwd: string) => string[] = (cwd) =>
    outsideCredentialArgs(cwd),
  repositoryOf: (cwd: string) => string | undefined = rootRepository,
): Runner {
  const known = new Map<string, string[]>();
  const repositories = new Map<string, string | undefined>();
  return (command, args, cwd, ...rest) => {
    if (command === 'gh') {
      // gh's App wrapper mints for KRN_APP_REPOSITORY: a gh call in an outside worktree names its origin.
      if (!repositories.has(cwd)) repositories.set(cwd, repositoryOf(cwd));
      const repository = repositories.get(cwd);
      return repository === undefined || repository === productRepository
        ? base(command, args, cwd, ...rest)
        : base(
            'env',
            [`KRN_APP_REPOSITORY=${repository}`, command, ...args],
            cwd,
            ...rest,
          );
    }
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
  kindOf: kindOfTitle,
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
