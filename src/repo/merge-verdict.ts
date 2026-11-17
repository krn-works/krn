// The one merge verdict of a lane; src/repo is shared by the CLI and the hook layers.

export type MergeVerdict = 'merged' | 'pr-open' | 'closed' | 'unshipped';

/**
 * The one merge verdict of a lane, shared by `lane status`, `lane prune` and the Stop hook.
 * A ship record counts only while the branch tip is the shipped head, so a branch advanced after
 * a successful ship is unshipped work; a record without a head needs a tip committed no later than
 * the ship (`committedAt`, ms), and a known tip with neither disowns it. Without a record, or once the tip moved, the newest pull request
 * decides: OPEN is pr-open, CLOSED is closed, MERGED is merged only when no record disowns the tip.
 */
export function laneMergeVerdict(input: {
  record?: { sha: string; head?: string; at?: string } | undefined;
  /** The branch tip; undefined when no tip is known. */
  head?: string | undefined;
  committedAt?: number | undefined;
  /** Whether a ship sha is on the base. */
  merged: (sha: string) => boolean;
  pr?: { state: string } | undefined;
}): MergeVerdict {
  const { record, head, committedAt, pr } = input;
  let owns = true;
  if (record && head !== undefined) {
    if (record.head !== undefined) owns = head === record.head;
    else {
      const shipped = Date.parse(String(record.at));
      owns =
        committedAt !== undefined &&
        Number.isFinite(shipped) &&
        committedAt <= shipped;
    }
  }
  if (record && owns && input.merged(record.sha)) return 'merged';
  const state = pr?.state.toUpperCase();
  if (state === 'OPEN') return 'pr-open';
  if (state === 'CLOSED') return 'closed';
  if (state === 'MERGED' && owns) return 'merged';
  return 'unshipped';
}
