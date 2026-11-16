import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shipCommand } from '../ci/ship.ts';
import { CliUsageError } from '../cli-kit/usage-error.ts';
import { contractBase } from '../repo/contract.ts';
import { mainCheckoutRoot } from '../task/claims.ts';
import {
  commitPendingRecords,
  pendingTaskFiles,
  removePendingTasks,
} from '../task/pending.ts';
import { repositoryRoot } from '../task/store.ts';
import { startLane } from './lane.ts';

export const publishUsage =
  'krn task publish [--dry-run]\nShip every task record created in the main checkout (held on refs/krn/pending-tasks) in one pull request through krn pr ship; the main checkout stays clean. Prints the ids and the ship verdict.';

export async function publishCommand(args: string[]): Promise<string> {
  const dryRun = args.includes('--dry-run');
  if (args.some((arg) => arg !== '--dry-run'))
    throw new CliUsageError(publishUsage);
  const main = mainCheckoutRoot(repositoryRoot());
  const files = pendingTaskFiles(main);
  if (files.size === 0) return 'publish: no pending task records\n';
  const ids = [...files.keys()].sort();
  if (dryRun) return `publish --dry-run: ${ids.join(' ')}\n`;
  const { path } = await startLane([`task-records-${ids[0]}`, '--root', main]);
  const commit = commitPendingRecords(path, files);
  const bodyFile = join(path, '.krn', 'tmp', 'publish-body.md');
  mkdirSync(join(path, '.krn', 'tmp'), { recursive: true });
  writeFileSync(bodyFile, commit.body);
  // The records are new and open: their Proof commands name work not yet done, so none runs here.
  const verdict = await shipCommand(
    ['--worktree', path, '--title', commit.title, '--body-file', bodyFile],
    { baseOf: contractBase, proofOf: () => [] },
  );
  removePendingTasks(main, commit.ids);
  return `publish: ${commit.ids.join(' ')}\n${verdict}\n`;
}
