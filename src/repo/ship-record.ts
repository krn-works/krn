import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where a merged ship is recorded, relative to the main checkout (ignored state). */
export const shipRecordDir = '.krn/runs/ship';

/**
 * Records that a lane branch merged, before its worktree and branch are removed, so the Stop hook can
 * tell a shipped lane from one that never committed. Evidence only: a failed write never fails a ship.
 */
export function recordShip(
  main: string,
  record: { branch: string; sha: string; head?: string; task?: string },
): void {
  try {
    const dir = join(main, shipRecordDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${encodeURIComponent(record.branch)}.json`),
      `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`,
    );
  } catch {
    /* Evidence only. */
  }
}

/**
 * Forgets the merged ship of a branch name a new lane is about to reuse: the record belongs to the old lane.
 * Returns the undo a refused lane start runs, which puts the record back byte for byte.
 */
export function forgetShip(main: string, branch: string): () => void {
  const path = join(main, shipRecordDir, `${encodeURIComponent(branch)}.json`);
  let before: Buffer | undefined;
  try {
    before = readFileSync(path);
  } catch {
    // Missing or unreadable: still forgotten, with nothing to put back.
  }
  rmSync(path, { force: true });
  return () => {
    if (before !== undefined) writeFileSync(path, before);
  };
}
