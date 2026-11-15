// Retirement of records that show no benefit: a record whose own check fails on served scoped diffs
// about as often as on withheld ones gets a `valid_to` of the day of the edit (ADR 0021). Pure
// selection and the file edit; the operator vetoes by closing the PR that carries it.
import { readFileSync, writeFileSync } from 'node:fs';
import { type EffectTotals, type Exposure, effectTotals } from './exposures.ts';

/** Served scoped diffs (the record's check ran on the final diff) a record needs before it is judged. */
export const RETIRE_SERVED = 30;

/** Withheld scoped diffs a record needs: with fewer there is nothing to compare the served diffs with. */
export const RETIRE_WITHHELD = 10;

/** A record retires when the one-sided chance of a benefit this large by luck is at least this. */
export const RETIRE_P = 0.1;

const logFactorial = (n: number): number => {
  let sum = 0;
  for (let i = 2; i <= n; i++) sum += Math.log(i);
  return sum;
};

/**
 * One-sided Fisher exact p of the benefit seen in a 2x2 table: the chance, with the margins fixed, that
 * the served diffs hold `servedViolated` or fewer of the `servedViolated + withheldViolated` violations.
 */
export function fisherBenefitP(
  servedViolated: number,
  servedTotal: number,
  withheldViolated: number,
  withheldTotal: number,
): number {
  const total = servedTotal + withheldTotal;
  const violated = servedViolated + withheldViolated;
  const logChoose = (n: number, k: number): number =>
    logFactorial(n) - logFactorial(k) - logFactorial(n - k);
  let p = 0;
  for (let x = 0; x <= servedViolated; x++) {
    if (violated - x > withheldTotal || x > servedTotal) continue;
    p += Math.exp(
      logChoose(violated, x) +
        logChoose(total - violated, servedTotal - x) -
        logChoose(total, servedTotal),
    );
  }
  return Math.min(1, p);
}

/** True when the record has enough scoped diffs in both arms and serving it shows no benefit under Fisher's exact test. */
export function showsNoEffect(totals: EffectTotals): boolean {
  if (
    totals.servedScoped < RETIRE_SERVED ||
    totals.withheldScoped < RETIRE_WITHHELD
  )
    return false;
  return (
    fisherBenefitP(
      totals.servedViolated,
      totals.servedScoped,
      totals.withheldViolated,
      totals.withheldScoped,
    ) >= RETIRE_P
  );
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
