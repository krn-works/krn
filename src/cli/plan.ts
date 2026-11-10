// `krn plan`: one line with plan points left per account and the account to spend next.
import { resolve } from 'node:path';
import { readPlanLine } from '../outcome/plan-gauge.ts';
import { flagValue } from './flag-value.ts';
import { CliUsageError } from './usage-error.ts';

// Samples live in the main checkout (KRN-08); a worktree path maps to it.
const mainCheckout = (dir: string) => {
  const at = dir.indexOf('/.krn/worktrees/');
  return at === -1 ? dir : dir.slice(0, at);
};

export async function planCommand(args: string[]): Promise<void> {
  let root = mainCheckout(process.cwd());
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--root')
      root = resolve(
        flagValue(args, i++, () => new CliUsageError('--root needs DIR')),
      );
    else throw new CliUsageError(`krn plan: unknown flag ${flag}`);
  }
  process.stdout.write(`${await readPlanLine(root, Date.now())}\n`);
}
