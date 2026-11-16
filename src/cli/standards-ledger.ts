// `krn standards harvest --from-ledger [REPO...]`: the harvest of written proposals plus one
// proposal per rework or CI-failed merged PR the outcome ledger reports for each repository.
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  type EvidenceProposal,
  evidenceProposals,
  renderEvidenceProposals,
  subjectsInForce,
  writeTrialRecords,
} from '../brain/evidence-proposals.ts';
import { readExposures } from '../brain/exposures.ts';
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
import { callRun, collectLedger, walk } from '../outcome/ledger.ts';
import { mainCheckoutRoot } from '../task/claims.ts';

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

async function jsonLines<T>(path: string): Promise<T[]> {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.split('\n').flatMap((line) => {
    try {
      return line.trim() === '' ? [] : [JSON.parse(line) as T];
    } catch {
      return [];
    }
  });
}

/** The trial record proposals the delivered evidence of the repository at `root` supports. */
export async function proposalsFromEvidence(
  root: string,
  rows: LedgerRows = readRows,
  recordedAt = new Date().toISOString().slice(0, 10),
): Promise<EvidenceProposal[]> {
  const main = mainCheckoutRoot(root);
  const files = (
    await Promise.all(
      ['.krn/runs', '.krn/archive'].map((dir) => walk(join(main, dir))),
    )
  ).flatMap((found) => found.files);
  const reviews = await Promise.all(
    files
      .filter((file) =>
        /(?:^|\/)review-series(?:\/[^/]+|-.*)\/records\/[^/]+\.json$/u.test(
          file,
        ),
      )
      .map((file) =>
        readFile(file, 'utf8').then(
          (text) => JSON.parse(text) as unknown,
          () => null,
        ),
      ),
  );
  return evidenceProposals(
    {
      ci: await rows(root),
      exposures: readExposures(main),
      reviews,
      inbox: await jsonLines(join(main, '.krn/operator/inbox.jsonl')),
      dispositions: await jsonLines(
        join(main, '.krn/operator/dispositions.jsonl'),
      ),
    },
    subjectsInForce(root),
    recordedAt,
  );
}

export async function harvestLedgerCommand(
  rest: readonly string[],
): Promise<void> {
  const dryRun = rest.includes('--dry-run');
  const write = rest.includes('--write');
  if (dryRun || write) {
    const flagless = rest.filter(
      (arg) => !['--from-ledger', '--dry-run', '--write'].includes(arg),
    );
    const at = flagless.indexOf('--root');
    const root = resolve(at >= 0 ? (flagless[at + 1] ?? '.') : '.');
    const proposals = await proposalsFromEvidence(repositoryRoot(root));
    if (write)
      process.stdout.write(
        `wrote ${writeTrialRecords(repositoryRoot(root), proposals)} trial record(s) to .agents/records.json\n`,
      );
    for (const line of renderEvidenceProposals(proposals))
      process.stdout.write(`${line}\n`);
    return;
  }
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
