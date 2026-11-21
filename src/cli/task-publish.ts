import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shipCommand } from '../ci/ship.ts';
import { CliUsageError } from '../cli-kit/usage-error.ts';
import { mainCheckoutRoot } from '../task/claims.ts';
import { branchOnOrigin, pendingTaskFiles } from '../task/pending.ts';
import { publishPendingRecords, settlePublished } from '../task/storage.ts';
import { repositoryRoot } from '../task/store.ts';
import { dropLane, startLane } from './lane.ts';
import { cliShipRuntime } from './pr.ts';

export const publishUsage =
  'krn task publish [--dry-run]\nShip every task record created in the main checkout (held on refs/krn/pending-tasks) in one pull request through krn pr ship; the main checkout stays clean. Prints the ids and the ship verdict.';

/**
 * A publish that failed before its branch reached the origin leaves a worktree and branch that
 * make the retry exit 64 "already exists": drop them. The records stay on the pending ref.
 * A pushed branch may carry an open PR, so it stays for `krn pr ship` to reuse.
 */
async function dropUnpushedLane(main: string, slug: string): Promise<void> {
  if (branchOnOrigin(main, slug)) return;
  try {
    await dropLane([slug, '--root', main]);
  } catch {
    // The original failure is the one to report.
  }
}

/** `runtime` overrides pieces of the `krn pr ship` runtime; tests inject gh through it. */
export async function publishCommand(
  args: string[],
  runtime: Parameters<typeof shipCommand>[1] = {},
): Promise<string> {
  const dryRun = args.includes('--dry-run');
  if (args.some((arg) => arg !== '--dry-run'))
    throw new CliUsageError(publishUsage);
  const main = mainCheckoutRoot(repositoryRoot(runtime.cwd));
  const files = pendingTaskFiles(main);
  if (files.size === 0) return 'publish: no pending task records\n';
  const ids = [...files.keys()].sort();
  if (dryRun) return `publish --dry-run: ${ids.join(' ')}\n`;
  const { path, slug } = await startLane([
    `task-records-${ids[0]}`,
    '--root',
    main,
  ]);
  let commit: ReturnType<typeof publishPendingRecords>;
  let verdict: string;
  try {
    commit = publishPendingRecords(path, files);
    const bodyFile = join(path, '.krn', 'tmp', 'publish-body.md');
    mkdirSync(join(path, '.krn', 'tmp'), { recursive: true });
    writeFileSync(bodyFile, commit.body);
    // Same guards as `krn pr ship` (deploy refusal, claim release). The records are new and
    // open: their Proof commands name work not yet done, so none runs here.
    verdict = await shipCommand(
      ['--worktree', path, '--title', commit.title, '--body-file', bodyFile],
      {
        ...cliShipRuntime,
        cwd: main,
        proofOf: () => [],
        kindOf: () => undefined,
        ...runtime,
      },
    );
  } catch (error) {
    await dropUnpushedLane(main, slug);
    throw error;
  }
  settlePublished(main, commit.ids);
  return `publish: ${commit.ids.join(' ')}\n${verdict}\n`;
}
