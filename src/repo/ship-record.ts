import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** Forgets the merged ship of a branch name a new lane is about to reuse: the record belongs to the old lane. */
export function forgetShip(main: string, branch: string): void {
  rmSync(join(main, shipRecordDir, `${encodeURIComponent(branch)}.json`), {
    force: true,
  });
}
