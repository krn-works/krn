// `krn standards harvest --from-ledger [REPO...]`: the harvest of written proposals plus one
// proposal per rework or CI-failed merged PR the outcome ledger reports for each repository.
import { basename, resolve } from 'node:path';
import {
  harvestCandidates,
  type LedgerRow,
  ledgerProposals,
  renderHarvest,
  type Sourced,
} from '../brain/proposals.ts';
import {
  adoptedRepositories,
  hostRepositories,
  readProposals,
  repositoryRoot,
  StandardsInputError,
} from '../brain/standards-cli.ts';
import { callRun, collectLedger } from '../outcome/ledger.ts';

/** Merged PRs read per repository. */
const LEDGER_LIMIT = 50;

export type LedgerRows = (root: string) => Promise<readonly LedgerRow[]>;

const readRows: LedgerRows = async (root) =>
  (
    await collectLedger({
      root,
      limit: LEDGER_LIMIT,
      run: callRun(5_000, root),
    })
  ).rows;

/** The harvest report lines over `repositories`: their proposals and their ledger lessons. */
export async function harvestWithLedger(
  repositories: readonly string[],
  rows: LedgerRows = readRows,
  recordedAt = new Date().toISOString().slice(0, 10),
): Promise<string[]> {
  const roots = [...new Set(repositories.map((path) => repositoryRoot(path)))];
  const sourced: Sourced[] = [];
  for (const root of roots) {
    sourced.push(...readProposals(root));
    sourced.push(
      ...ledgerProposals(basename(root), root, await rows(root), recordedAt),
    );
  }
  return renderHarvest(harvestCandidates(sourced), roots.length);
}

export async function harvestLedgerCommand(
  rest: readonly string[],
): Promise<void> {
  const args = rest.filter((arg) => arg !== '--from-ledger');
  const rootAt = args.indexOf('--root');
  const root = rootAt >= 0 ? args[rootAt + 1] : undefined;
  const positional = args.filter(
    (arg, i) => arg !== '--root' && !(rootAt >= 0 && i === rootAt + 1),
  );
  if (rootAt >= 0 && root === undefined)
    throw new StandardsInputError('krn standards harvest: --root needs a path');
  const repositories =
    positional.length > 0
      ? positional.map((path) => resolve(path))
      : root === undefined
        ? hostRepositories()
        : adoptedRepositories(resolve(root));
  for (const line of await harvestWithLedger(repositories))
    process.stdout.write(`${line}\n`);
}
