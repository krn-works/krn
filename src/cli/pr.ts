import { deployRemedy, deployWorkflows } from '../adopt/deploy.ts';
import { shipCommand, shipUsage } from '../ci/ship.ts';
import { contractBase, contractDeployAcknowledged } from '../repo/contract.ts';
import { openDecisionOnce } from './decide.ts';
import { proofOfTitle } from './pr-body.ts';

/** One open `krn decide` row for a refused workflow push, so the operator is asked once and the lane never ends in a BLOCKER. */
function decideWorkflowRefusal(main: string, files: string[]): string {
  const today = new Date();
  const deadline = new Date(today.getTime() + 7 * 86_400_000);
  return openDecisionOnce(
    main,
    {
      question: `Grant the KRN GitHub App the Workflows (write) permission, or push ${files.join(', ')} once with a user login`,
      recommendation:
        'grant Workflows (write) to the App so adoption and remediation PRs carry their CI workflow',
      default:
        'push the pinned branch once with a user login holding the workflow scope, then rerun krn pr ship',
      deadline: deadline.toISOString().slice(0, 10),
    },
    today.toISOString().slice(0, 10),
  ).id;
}

export async function prCommand(args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (verb === 'ship')
    process.stdout.write(
      `${await shipCommand(rest, {
        baseOf: contractBase,
        proofOf: proofOfTitle,
        decideWorkflowRefusal,
        deployRefusal: (cwd, base) => {
          const files = deployWorkflows(cwd, base);
          return files.length > 0 && !contractDeployAcknowledged(cwd)
            ? deployRemedy(files, base)
            : undefined;
        },
      })}\n`,
    );
  else if (verb === 'body') {
    const { prBodyCommand } = await import('./pr-body.ts');
    process.stdout.write(prBodyCommand(rest));
  } else throw Object.assign(new Error(shipUsage), { exitCode: 64 });
}
