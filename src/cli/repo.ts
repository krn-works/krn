// `krn repo contract`: print the repo contract (krn.json merged over detection) as JSON.
import { resolve } from 'node:path';
import { flagValue } from '../cli-kit/flag-value.ts';
import { CliUsageError } from '../cli-kit/usage-error.ts';
import { ContractError, resolveContract } from '../repo/contract.ts';

export function repoCommand(args: string[]): void {
  const [verb, ...rest] = args;
  if (verb !== 'contract')
    throw new CliUsageError(
      'krn repo contract [--root DIR]  print the repo contract as JSON',
    );
  let root = process.cwd();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--root')
      root = resolve(
        flagValue(rest, i++, () => new CliUsageError('--root needs DIR')),
      );
    else throw new CliUsageError(`krn repo contract: unknown flag ${flag}`);
  }
  try {
    const resolved = resolveContract(root);
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    process.stderr.write(`krn repo contract: ${error.message}\n`);
    process.exitCode = 65;
  }
}
