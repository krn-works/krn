// `krn standards check --tasks`: the check, after each floor or reflex failure of the repository
// became one ready task in its own tracker (once: a failure already tracked is not written again).
import { resolve } from 'node:path';
import { trackFailures } from '../adopt/failure-tasks.ts';
import {
  repositoryRoot,
  standardsCommand,
  standardsFailures,
  usage,
} from '../brain/standards-cli.ts';
import { CliUsageError } from '../cli-kit/usage-error.ts';

export function checkWithTasks(rest: readonly string[]): void {
  const args = rest.filter((arg) => arg !== '--tasks');
  const rootAt = args.indexOf('--root');
  if (args.includes('--record')) throw new CliUsageError(usage);
  const root = repositoryRoot(
    resolve(rootAt >= 0 ? (args[rootAt + 1] ?? '') : process.cwd()),
  );
  const asOf = new Date().toISOString().slice(0, 10);
  for (const title of trackFailures(
    root,
    standardsFailures(root, asOf),
    'a standards check',
    true,
  ))
    process.stderr.write(`task: ${title}\n`);
  standardsCommand(['check', ...args]);
}
