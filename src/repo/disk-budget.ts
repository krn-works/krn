// The one owner of the host disk budget: a lane start and a replay run refuse below KRN_LANE_MIN_FREE_GB free
// (default 5) on each directory they write, so a long run never fills the disk other work shares.
import { statfsSync } from 'node:fs';

/** A numeric environment limit; unset, empty, negative or non-numeric keeps the fallback. */
export function envLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 && process.env[name] !== ''
    ? value
    : fallback;
}

/** Free gigabytes under `dir`; undefined when the path cannot be probed. */
export function freeGb(dir: string): number | undefined {
  try {
    const stats = statfsSync(dir);
    return (stats.bavail * stats.bsize) / 1024 ** 3;
  } catch {
    return undefined;
  }
}

export const minFreeGb = (): number => envLimit('KRN_LANE_MIN_FREE_GB', 5);

export interface BudgetShortfall {
  dir: string;
  free: number;
  minFree: number;
}

/** The first directory with less than the budget free, or undefined when every probed one holds it. */
export function budgetShortfall(
  dirs: readonly string[],
  probe: (dir: string) => number | undefined = freeGb,
): BudgetShortfall | undefined {
  const minFree = minFreeGb();
  for (const dir of dirs) {
    const free = probe(dir);
    if (free !== undefined && free < minFree) return { dir, free, minFree };
  }
  return undefined;
}
