// A/B/C confirmatory analysis (ADR 0021 point 7): one verdict per contrast, Holm-adjusted over the contrasts,
// cost as co-primary, "not shown" a published result. Pure functions over rows and the frozen preregistration.
import { type Observation, pairedDifference } from '../d23/analysis.ts';
import type { ArmId } from './arms.ts';
import { type Interval, rowCost, usdPerResolvedCi } from './cost-stats.ts';
import type { Row } from './rows.ts';
import {
  LIST_PRICES,
  NO_CACHE_DISCOUNT,
  type PriceVector,
} from './token-cost.ts';

export interface Prereg {
  /** The frozen unit list. */
  units: string[];
  reps: number;
  alpha: number;
  /** Minimum detectable effect in percentage points at power 0.8. */
  mdePp: number;
  /** Each contrast is `[treatment, control]`: the estimate is treatment minus control. */
  contrasts: [ArmId, ArmId][];
  /** Model families the run is pinned to (from the `model:` line); a row realizing any other is not the matrix. */
  models?: string[];
  /** The harness content hash frozen at the freeze commit (`harness-sha:`); absent until frozen. */
  harness?: string;
  /** The `cost-prices` vector rows are priced at; absent means token-cost.ts LIST_PRICES (parsePrereg always sets it). */
  prices?: PriceVector;
  /** The `cost-sensitivity` vector the cost lines are repeated at; absent means NO_CACHE_DISCOUNT. */
  sensitivity?: PriceVector;
}

export const field = (text: string, name: string): string => {
  const m = new RegExp(`^${name}:[ \\t]*(.+)$`, 'm').exec(text);
  if (!m) throw new Error(`prereg lacks "${name}:"`);
  return (m[1] as string).trim();
};

const PRICE_KEYS: [string, keyof PriceVector][] = [
  ['input', 'input'],
  ['output', 'output'],
  ['cache-read', 'cacheRead'],
  ['cache-write-5m', 'cacheWrite5m'],
  ['cache-write-1h', 'cacheWrite1h'],
];

const renderPrices = (p: PriceVector): string =>
  PRICE_KEYS.map(([k, f]) => `${k} ${p[f]}`).join(', ');

/** Reads a `name:` price vector line and refuses one whose numbers differ from the vector token-cost.ts holds. */
function priceVector(text: string, name: string, known: PriceVector) {
  const line = field(text, name);
  const given = new Map(
    line.split(',').map((part) => {
      const [key = '', value = ''] = part.trim().split(/\s+/);
      return [key, value === '' ? Number.NaN : Number(value)] as const;
    }),
  );
  const same =
    given.size === PRICE_KEYS.length &&
    PRICE_KEYS.every(([k, f]) => given.get(k) === known[f]);
  if (!same)
    throw new Error(
      `prereg ${name} "${line}" differs from token-cost.ts "${renderPrices(known)}"`,
    );
  return known;
}

/** Reads `Key: value` lines (reps, alpha, mde-pp, contrasts) and the `- t-...` bullets of the unit list. */
export function parsePrereg(text: string): Prereg {
  const units = [...text.matchAll(/^- (t-[0-9a-z]+)\s*$/gm)].map(
    (m) => m[1] as string,
  );
  if (units.length === 0) throw new Error('prereg lists no units');
  const contrasts = field(text, 'contrasts')
    .split(',')
    .map((c) => {
      const m = /^\s*([ABC])-([ABC])\s*$/.exec(c);
      if (!m) throw new Error(`bad contrast: ${c}`);
      return [m[1], m[2]] as [ArmId, ArmId];
    });
  const models = [
    ...field(text, 'model')
      .toLowerCase()
      .matchAll(/[a-z][a-z0-9.-]*/g),
  ]
    .map((m) => m[0])
    .filter((w) => /^(sonnet|opus|haiku|fable)/.test(w));
  const harness = /^harness-sha:[ \t]*([0-9a-f]+)[ \t]*$/m.exec(text)?.[1];
  return {
    units,
    reps: Number(field(text, 'reps')),
    models,
    ...(harness === undefined ? {} : { harness }),
    alpha: Number(field(text, 'alpha')),
    mdePp: Number(field(text, 'mde-pp')),
    contrasts,
    prices: priceVector(text, 'cost-prices', LIST_PRICES),
    sensitivity: priceVector(text, 'cost-sensitivity', NO_CACHE_DISCOUNT),
  };
}

/** Holm step-down adjustment: sort ascending, scale by the remaining count, keep the sequence monotone, cap at 1. */
export function holm(ps: number[]): number[] {
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const out = new Array<number>(ps.length).fill(1);
  let running = 0;
  order.forEach(({ p, i }, k) => {
    running = Math.max(running, Math.min(1, (ps.length - k) * p));
    out[i] = running;
  });
  return out;
}

const observation = (r: Row, prices: PriceVector): Observation => ({
  unit: r.unit,
  arm: r.arm,
  run: r.rep,
  correct: r.pass === true,
  scopeClean: true,
  refusal: false,
  costUsd: rowCost(r, prices) ?? Number.NaN,
});

export interface Contrast {
  name: string;
  units: number;
  /** Difference in pass rate, percentage points. */
  estimatePp: number;
  sePp: number;
  rawP: number;
  adjustedP: number;
  shown: boolean;
  /** Paired log of the geometric-mean cost ratio, treatment over control, per unit. */
  logCostRatio: number;
  logCostSe: number;
  /** 95% CI of the log ratio, clustered by unit over reps. */
  logCostCi: Interval;
  /** Units both arms have a cost for: the pair the log ratio is over. */
  costUnits: number;
  /** Holm-adjusted over the contrasts; the primary cost claim is shown when it is below alpha and C is cheaper. */
  costAdjustedP: number;
  costShown: boolean;
  /** The same cost line priced at the `cost-sensitivity` vector. */
  sensitivity: {
    logCostRatio: number;
    logCostSe: number;
    logCostCi: Interval;
    costUnits: number;
    costAdjustedP: number;
    costShown: boolean;
  };
  /** The cost verdict (shown or not) differs between the two vectors: the cache explains it. */
  cacheDependent: boolean;
}

/** One vector's cost figures: the per-contrast paired log ratios and USD per resolved task per arm. */
interface CostView {
  contrasts: Pick<
    Contrast,
    | 'logCostRatio'
    | 'logCostSe'
    | 'logCostCi'
    | 'costUnits'
    | 'costAdjustedP'
    | 'costShown'
  >[];
  usdPerResolved: Record<ArmId, number | null>;
  usdCi: Record<ArmId, Interval | null>;
  unknownCost: Record<ArmId, number>;
}

/** Regression rate (ADR 0021 point 10): graded rows that pass while breaking a base-passing test, per graded row. */
export interface Regression {
  /** Per arm: rate in 0..1 and the rows it is over. */
  rate: Partial<Record<ArmId, { rate: number; rows: number }>>;
  /** Treatment minus control in percentage points, clustered on the unit; undefined when no row records `regressed`. */
  contrast?: {
    name: string;
    units: number;
    diffPp: number;
    sePp: number;
    p: number;
  };
}

export interface AbcReport {
  graded: number;
  contrasts: Contrast[];
  /** Total USD over passing rows per arm, null with no pass. */
  usdPerResolved: Record<ArmId, number | null>;
  /** 95% bootstrap CI of USD per resolved task, seeded and clustered by unit; null with no pass. */
  usdCi: Record<ArmId, Interval | null>;
  /** Frozen-unit rows per arm whose cost is unknown (null); their spend is missing from the dollars, not zero. */
  unknownCost: Record<ArmId, number>;
  /** USD per resolved task priced at the `cost-sensitivity` vector. */
  usdPerResolvedSensitivity: Record<ArmId, number | null>;
  usdCiSensitivity: Record<ArmId, Interval | null>;
  /** The reported total_cost_usd per resolved task: a descriptive column, never a verdict input. */
  reportedUsdPerResolved: Record<ArmId, number | null>;
  regression: Regression;
}

/** The cost figures of `graded` and `spent` rows priced at `prices`; the contrasts are Holm-adjusted within the vector. */
function costView(
  graded: Row[],
  spent: Row[],
  prereg: Prereg,
  prices: PriceVector,
): CostView {
  const costObs = graded
    .map((r) => observation(r, prices))
    .filter((o) => o.costUsd > 0); // NaN (unknown cost) fails this
  const raw = prereg.contrasts.map(([t, c]) =>
    pairedDifference(costObs, t, c, (o) => Math.log(o.costUsd)),
  );
  const adjusted = holm(raw.map((r) => r.p));
  const contrasts = raw.map((cost, i) => ({
    logCostRatio: cost.diff,
    logCostSe: cost.se,
    logCostCi: { low: cost.ciLow, high: cost.ciHigh },
    costUnits: cost.units,
    costAdjustedP: adjusted[i] as number,
    costShown:
      cost.units > 1 && (adjusted[i] as number) < prereg.alpha && cost.diff < 0,
  }));
  // Dollars per resolution count every session's spend, graded or not; unknown costs add nothing and are counted.
  const usd = (arm: ArmId): number | null => {
    const passes = graded.filter((r) => r.arm === arm && r.pass).length;
    return passes === 0
      ? null
      : spent
          .filter((r) => r.arm === arm)
          .reduce((s, r) => s + (rowCost(r, prices) ?? 0), 0) / passes;
  };
  const unknown = (arm: ArmId): number =>
    spent.filter((r) => r.arm === arm && rowCost(r, prices) === undefined)
      .length;
  const arms = ['A', 'B', 'C'] as const;
  const each = <T>(f: (arm: ArmId) => T) =>
    Object.fromEntries(arms.map((arm) => [arm, f(arm)])) as Record<ArmId, T>;
  return {
    contrasts,
    usdPerResolved: each(usd),
    usdCi: each((arm) => usdPerResolvedCi(spent, graded, arm, prices)),
    unknownCost: each(unknown),
  };
}

/** Graded rows of frozen units only. A contrast is shown when its Holm-adjusted p is below alpha and C is better. */
export function analyze(rows: Row[], prereg: Prereg): AbcReport {
  const frozen = new Set(prereg.units);
  const graded = rows.filter((r) => r.pass !== null && frozen.has(r.unit));
  const spent = rows.filter((r) => frozen.has(r.unit));
  const main = costView(graded, spent, prereg, prereg.prices ?? LIST_PRICES);
  const alt = costView(
    graded,
    spent,
    prereg,
    prereg.sensitivity ?? NO_CACHE_DISCOUNT,
  );
  const obs = graded.map((r) => observation(r, LIST_PRICES));
  const raw = prereg.contrasts.map(([t, c]) => pairedDifference(obs, t, c));
  const adjusted = holm(raw.map((r) => r.p));
  const contrasts: Contrast[] = prereg.contrasts.map(([t, c], i) => {
    const r = raw[i] as ReturnType<typeof pairedDifference>;
    const cost = main.contrasts[i] as CostView['contrasts'][number];
    const sens = alt.contrasts[i] as CostView['contrasts'][number];
    return {
      name: `${t}-${c}`,
      units: r.units,
      estimatePp: r.diff * 100,
      sePp: r.se * 100,
      rawP: r.p,
      adjustedP: adjusted[i] as number,
      shown: (adjusted[i] as number) < prereg.alpha && r.diff > 0,
      ...cost,
      sensitivity: sens,
      cacheDependent: cost.costShown !== sens.costShown,
    };
  });
  const reported = (arm: ArmId): number | null => {
    const passes = graded.filter((r) => r.arm === arm && r.pass).length;
    const known = spent.filter((r) => r.arm === arm && r.cost != null);
    return passes === 0 || known.length === 0
      ? null
      : known.reduce((s, r) => s + (r.cost ?? 0), 0) / passes;
  };
  return {
    graded: graded.length,
    contrasts,
    usdPerResolved: main.usdPerResolved,
    usdCi: main.usdCi,
    unknownCost: main.unknownCost,
    usdPerResolvedSensitivity: alt.usdPerResolved,
    usdCiSensitivity: alt.usdCi,
    reportedUsdPerResolved: {
      A: reported('A'),
      B: reported('B'),
      C: reported('C'),
    },
    regression: regression(graded, prereg),
  };
}

/** Regression per arm over graded rows, and the first contrast's clustered difference; a run with no `regressed` field measures none. */
function regression(graded: Row[], prereg: Prereg): Regression {
  const measured = graded.some((r) => r.regressed !== undefined);
  if (!measured) return { rate: {} };
  const rate: Regression['rate'] = {};
  for (const arm of ['A', 'B', 'C'] as ArmId[]) {
    const mine = graded.filter((r) => r.arm === arm);
    if (mine.length > 0)
      rate[arm] = {
        rate: mine.filter((r) => r.pass && r.regressed).length / mine.length,
        rows: mine.length,
      };
  }
  // Observation.refusal carries the regression flag so the paired, unit-clustered estimator applies unchanged.
  const obs = graded.map((r) => ({
    ...observation(r, LIST_PRICES),
    refusal: r.pass === true && r.regressed === true,
  }));
  const [t, c] = prereg.contrasts.find(([, x]) => x === 'A') ?? [];
  if (t === undefined || c === undefined) return { rate };
  const d = pairedDifference(obs, t, c, (o) => (o.refusal ? 1 : 0));
  return {
    rate,
    contrast: {
      name: `${t}-${c}`,
      units: d.units,
      diffPp: d.diff * 100,
      sePp: d.se * 100,
      p: d.p,
    },
  };
}

/**
 * Why `rows` are not the preregistered matrix: a missing, ungraded or duplicated (unit, arm, rep) cell, a rep outside
 * 1..reps, a unit outside the frozen list, or rows from more than one harness or realized model. Empty when complete.
 */
export function matrixProblems(rows: Row[], prereg: Prereg): string[] {
  const problems: string[] = [];
  const arms = [...new Set(prereg.contrasts.flat())].sort();
  const frozen = new Set(prereg.units);
  const cells = new Map<string, Row[]>();
  for (const r of rows) {
    if (!frozen.has(r.unit)) {
      problems.push(`row for unit ${r.unit} outside the frozen list`);
      continue;
    }
    if (!Number.isInteger(r.rep) || r.rep < 1 || r.rep > prereg.reps)
      problems.push(
        `${r.unit} ${r.arm} rep ${r.rep} outside 1..${prereg.reps}`,
      );
    const cost = rowCost(r, prereg.prices);
    if (!(cost !== undefined && cost > 0))
      problems.push(
        `no tokens for ${r.unit} ${r.arm} rep ${r.rep} (total_cost_usd ${r.cost ?? 'absent'}, priced ${cost ?? 'absent'})`,
      );
    const k = `${r.unit} ${r.arm} ${r.rep}`;
    cells.set(k, [...(cells.get(k) ?? []), r]);
  }
  for (const unit of prereg.units)
    for (const arm of arms)
      for (let rep = 1; rep <= prereg.reps; rep++) {
        const got = cells.get(`${unit} ${arm} ${rep}`) ?? [];
        if (got.length === 0)
          problems.push(`missing ${unit} ${arm} rep ${rep}`);
        else if (got.length > 1)
          problems.push(
            `duplicate ${unit} ${arm} rep ${rep} (${got.length} rows)`,
          );
        else if ((got[0] as Row).pass === null)
          problems.push(`ungraded ${unit} ${arm} rep ${rep}`);
      }
  const harnesses = new Set(rows.map((r) => r.harness));
  if (harnesses.size > 1)
    problems.push(`mixed harness: ${[...harnesses].sort().join(', ')}`);
  if (prereg.harness === undefined) problems.push('prereg pins no harness-sha');
  else {
    const wrong = [...harnesses].filter((h) => h !== prereg.harness);
    if (wrong.length > 0)
      problems.push(
        `harness ${wrong.sort().join(', ')} is not the preregistered ${prereg.harness}`,
      );
  }
  const models = new Set(rows.map((r) => r.model ?? 'unknown'));
  if (models.size > 1)
    problems.push(`mixed realized model: ${[...models].sort().join(', ')}`);
  const pinned = prereg.models ?? [];
  const outside = [...models].filter(
    (m) =>
      m === 'unknown' ||
      !m
        .split(',')
        .every((k) => pinned.some((p) => k.toLowerCase().includes(p))),
  );
  if (outside.length > 0)
    problems.push(
      `realized model ${outside.sort().join(', ')} outside the pinned set ${pinned.join(', ') || '(none)'}`,
    );
  return problems;
}

/** What a refused strict matrix is: `incomplete` when cells are only missing or ungraded, else `incomplete or mixed`. */
export const matrixKind = (problems: string[]): string =>
  problems.every((p) => /^(missing|ungraded) /.test(p))
    ? 'incomplete'
    : 'incomplete or mixed';

const signed = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`;
const money = (x: number | null) => (x === null ? 'n/a' : x.toFixed(2));

const rate = (x: { rate: number; rows: number } | undefined) =>
  x === undefined ? 'n/a' : `${(x.rate * 100).toFixed(1)}%`;

/**
 * One `verdict:` line per primary claim (ADR 0021 point 11: USD per resolved task C against A and B under Holm, then
 * regression rate C against A), the `secondary:` pass-rate contrasts, and the cost detail lines.
 */
export function reportLines(r: AbcReport, prereg: Prereg): string[] {
  type CostFigures = Pick<
    Contrast,
    | 'logCostRatio'
    | 'logCostSe'
    | 'logCostCi'
    | 'costUnits'
    | 'costAdjustedP'
    | 'costShown'
  >;
  const costLine = (head: string, name: string, c: CostFigures) =>
    `${head} ${name} ratio ${Math.exp(c.logCostRatio).toFixed(2)} (log ${c.logCostRatio.toFixed(3)}, 95% CI [${Math.exp(c.logCostCi.low).toFixed(2)}, ${Math.exp(c.logCostCi.high).toFixed(2)}], clustered SE ${c.logCostSe.toFixed(3)}, n ${c.costUnits} units), Holm p ${c.costAdjustedP.toFixed(4)}, ${c.costShown ? 'shown' : 'not shown'} (alpha ${prereg.alpha})`;
  const lines = r.contrasts.map(
    (c) =>
      costLine('verdict: cost', c.name, c) +
      (c.cacheDependent ? ' cache-dependent' : ''),
  );
  const g = r.regression.contrast;
  lines.push(
    g === undefined
      ? 'verdict: regression not measured (no graded row records regressed)'
      : `verdict: regression ${g.name} ${signed(g.diffPp)} pp (A ${rate(r.regression.rate.A)}, B ${rate(r.regression.rate.B)}, C ${rate(r.regression.rate.C)}), clustered SE ${g.sePp.toFixed(1)} pp (${g.units} units), p ${g.p.toFixed(4)}, descriptive`,
  );
  for (const c of r.contrasts)
    lines.push(
      `secondary: pass rate ${c.name} ${signed(c.estimatePp)} pp, clustered SE ${c.sePp.toFixed(1)} pp (${c.units} units), Holm p ${c.adjustedP.toFixed(4)}, ${c.shown ? 'shown' : 'not shown'} (alpha ${prereg.alpha}, MDE ${prereg.mdePp} pp)`,
    );
  for (const c of r.contrasts)
    lines.push(
      `${costLine('sensitivity: cost at cost-sensitivity', c.name, c.sensitivity)}${c.cacheDependent ? ' cache-dependent' : ''}`,
    );
  const u = r.usdPerResolved;
  lines.push(
    `cost: USD per resolved task A ${money(u.A)}, B ${money(u.B)}, C ${money(u.C)}`,
  );
  for (const arm of ['A', 'B', 'C'] as ArmId[]) {
    const ci = r.usdCi[arm];
    lines.push(
      `cost: USD per resolved ${arm} ${money(u[arm])} 95% CI ${ci === null ? 'n/a' : `[${money(ci.low)}, ${money(ci.high)}]`} (bootstrap over units, seeded)`,
    );
  }
  const us = r.usdPerResolvedSensitivity;
  lines.push(
    `cost: at cost-sensitivity USD per resolved task A ${money(us.A)}, B ${money(us.B)}, C ${money(us.C)}`,
  );
  for (const arm of ['A', 'B', 'C'] as ArmId[]) {
    const ci = r.usdCiSensitivity[arm];
    lines.push(
      `cost: at cost-sensitivity USD per resolved ${arm} ${money(us[arm])} 95% CI ${ci === null ? 'n/a' : `[${money(ci.low)}, ${money(ci.high)}]`} (bootstrap over units, seeded)`,
    );
  }
  const rp = r.reportedUsdPerResolved;
  lines.push(
    `cost: reported total_cost_usd per resolved task A ${money(rp.A)}, B ${money(rp.B)}, C ${money(rp.C)} (descriptive only)`,
  );
  const k = r.unknownCost;
  if (k.A + k.B + k.C > 0)
    lines.push(
      `cost: rows with unknown cost A ${k.A}, B ${k.B}, C ${k.C} (no tokens; their spend is missing from the dollars above)`,
    );
  return lines;
}

/** The one number a registered metric prints; undefined when the metric is unknown or has no data. */
export function metricValue(name: string, r: AbcReport): number | undefined {
  if (name === 'c-minus-a-pp')
    return r.contrasts.find((c) => c.name === 'C-A')?.estimatePp;
  if (name === 'c-cost-per-resolved-ratio') {
    const { A, C } = r.usdPerResolved;
    return A === null || C === null || A === 0 ? undefined : C / A;
  }
  return undefined;
}
