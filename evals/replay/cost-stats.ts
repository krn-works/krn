// Cost statistics for the A/B/C report (ADR 0021 points 10-11): a seeded, unit-clustered bootstrap for USD per resolved
// task. Pure and deterministic; the paired log-ratio CI comes from pairedDifference in the d23 analysis.
import type { ArmId } from './arms.ts';
import type { Row } from './rows.ts';
import { LIST_PRICES, type PriceVector, tokenCost } from './token-cost.ts';

export interface Interval {
  low: number;
  high: number;
}

/**
 * The one reader of a row's session cost in USD: its tokens priced at `prices` (the preregistered `cost-prices` vector
 * by default); undefined when the row records no tokens, never 0. The reported total_cost_usd is not read here.
 */
export const rowCost = (
  r: Row,
  prices: PriceVector = LIST_PRICES,
): number | undefined =>
  r.tokens === null || r.tokens === undefined
    ? undefined
    : tokenCost(r.tokens, prices);

export const BOOTSTRAP_RESAMPLES = 2000;
const SEED = 0x2545f491;

/** mulberry32: a small deterministic generator so the interval is the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile bootstrap (95%) of total spend over passing rows for one arm, resampling units with their reps.
 * `spent` holds every frozen-unit row (graded or not, unknown cost adds nothing); `graded` the graded rows. Null when
 * no resample has a pass.
 */
export function usdPerResolvedCi(
  spent: Row[],
  graded: Row[],
  arm: ArmId,
  prices: PriceVector = LIST_PRICES,
): Interval | null {
  const per = new Map<string, { usd: number; passes: number }>();
  const cell = (unit: string) => {
    const c = per.get(unit) ?? { usd: 0, passes: 0 };
    per.set(unit, c);
    return c;
  };
  for (const r of spent)
    if (r.arm === arm) cell(r.unit).usd += rowCost(r, prices) ?? 0;
  for (const r of graded) if (r.arm === arm && r.pass) cell(r.unit).passes += 1;
  const cells = [...per.keys()]
    .sort()
    .map((u) => per.get(u) as { usd: number; passes: number });
  if (cells.length === 0) return null;
  const next = rng(SEED);
  const draws: number[] = [];
  for (let b = 0; b < BOOTSTRAP_RESAMPLES; b++) {
    let usd = 0;
    let passes = 0;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[Math.floor(next() * cells.length)] as {
        usd: number;
        passes: number;
      };
      usd += c.usd;
      passes += c.passes;
    }
    if (passes > 0) draws.push(usd / passes);
  }
  if (draws.length === 0) return null;
  draws.sort((x, y) => x - y);
  const at = (q: number) =>
    draws[Math.min(draws.length - 1, Math.floor(q * draws.length))] as number;
  return { low: at(0.025), high: at(0.975) };
}
