import type { Job } from '../core/index.ts';
import type { Contract, Ledger, ReviewSubmission } from './index.ts';

type LiveLedger = Pick<
  Ledger,
  'readContract' | 'readBoard' | 'submitForReview'
>;

export async function loadLiveContract(
  ledger: Pick<Ledger, 'readContract' | 'readBoard'>,
  issue: string,
  options: { readonly origin: string; readonly revision?: string },
) {
  const job: Job = { id: 'live', issue, worktree: process.cwd() };
  const [contract, board] = await Promise.all([
    ledger.readContract(issue),
    ledger.readBoard(job),
  ]);
  if (contract.revision !== board.updatedAt)
    throw new Error('Paperclip board changed while loading contract');
  if (options.revision && options.revision !== board.updatedAt)
    throw new Error('--revision mismatch with Paperclip board revision');
  if (
    repositoryFromRemote(options.origin) !==
    normalizeRepository(contract.targetRepo)
  )
    throw new Error('krn-contract targetRepo mismatch with origin remote');
  return { contract, board };
}

export function withLiveSubmissionGate(
  ledger: LiveLedger,
  submit: boolean,
): LiveLedger {
  return {
    ...ledger,
    submitForReview: (...args): Promise<ReviewSubmission> =>
      submit
        ? ledger.submitForReview(...args)
        : Promise.resolve('ready_for_review'),
  };
}

function normalizeRepository(value: string): string {
  return value
    .replace(/\.git$/i, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function repositoryFromRemote(remote: string): string {
  const match =
    /^(?:https?|ssh|git):\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(
      remote,
    ) ?? /^[^@]+@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/i.exec(remote);
  if (!match?.[1])
    throw new Error('unable to parse origin remote owner/repository');
  return normalizeRepository(match[1]);
}

export type { Contract };
