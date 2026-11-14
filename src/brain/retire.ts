// Retirement of prose standards that show no effect: a record with enough exposures whose served
// runs deliver no more often than the runs that were withheld it gets a `valid_to` of the day of
// the edit. Pure selection and the file edit; the operator vetoes by closing the PR that carries it.
import { readFileSync, writeFileSync } from 'node:fs';
import { type EffectTotals, type Exposure, effectTotals } from './exposures.ts';

/** Exposures (served plus withheld) a record needs before its effect is judged. */
export const RETIRE_EXPOSURES = 30;

/** Withheld runs a record needs: with none there is nothing to compare the served runs with. */
export const RETIRE_WITHHELD = 3;

/** True when the record has been judged and the served runs deliver no more often than the withheld ones. */
export function showsNoEffect(totals: EffectTotals): boolean {
  if (totals.served + totals.withheld < RETIRE_EXPOSURES) return false;
  if (totals.withheld < RETIRE_WITHHELD || totals.served === 0) return false;
  return totals.servedOk * totals.withheld <= totals.withheldOk * totals.served;
}

/** Ids of the records to retire, in id order: those of `ids` still in force at `asOf` that show no effect. */
export function retirable(
  exposures: readonly Exposure[],
  inForce: ReadonlySet<string>,
): string[] {
  return [...effectTotals(exposures)]
    .filter(([id, totals]) => inForce.has(id) && showsNoEffect(totals))
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b));
}

/** Ids of the rows of a records file still in force on `asOf`. */
export function recordsInForce(path: string, asOf: string): string[] {
  return rowsOf(path)
    .filter(
      (row) =>
        row.status !== 'retired' &&
        (row.valid_to === null || String(row.valid_to) >= asOf),
    )
    .map((row) => String(row.id));
}

function rowsOf(path: string): Record<string, unknown>[] {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`${path}: expected a JSON array`);
  return value as Record<string, unknown>[];
}

/** Sets `valid_to` to `asOf` on the listed rows of a records file; returns the ids it changed. */
export function retireInFile(
  path: string,
  ids: ReadonlySet<string>,
  asOf: string,
): string[] {
  const rows = rowsOf(path);
  const changed: string[] = [];
  for (const row of rows) {
    if (!ids.has(String(row.id))) continue;
    const from = String(row.valid_from);
    row.valid_to = asOf < from ? from : asOf;
    changed.push(String(row.id));
  }
  if (changed.length > 0)
    writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`);
  return changed;
}
