// A/B/C confirmatory analysis (ADR 0021 point 7): one verdict per contrast, Holm-adjusted over the contrasts,
// cost as co-primary, "not shown" a published result. Pure functions over rows and the frozen preregistration.
import { type Observation, pairedDifference } from '../d23/analysis.ts';
import type { ArmId } from './arms.ts';
import type { Row } from './rows.ts';

export interface Prereg {
  /** The frozen unit list. */
  units: string[];
  reps: number;
  alpha: number;
  /** Minimum detectable effect in percentage points at power 0.8. */
  mdePp: number;
  /** Each contrast is `[treatment, control]`: the estimate is treatment minus control. */
  contrasts: [ArmId, ArmId][];
}

const field = (text: string, name: string): string => {
  const m = new RegExp(`^${name}:[ \\t]*(.+)$`, 'm').exec(text);
  if (!m) throw new Error(`prereg lacks "${name}:"`);
  return (m[1] as string).trim();
};

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
  return {
    units,
    reps: Number(field(text, 'reps')),
    alpha: Number(field(text, 'alpha')),
    mdePp: Number(field(text, 'mde-pp')),
    contrasts,
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

const observation = (r: Row): Observation => ({
  unit: r.unit,
  arm: r.arm,
  run: r.rep,
  correct: r.pass === true,
  scopeClean: true,
  refusal: false,
  costUsd: r.cost,
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
}

export interface AbcReport {
  graded: number;
  contrasts: Contrast[];
  /** Total USD over passing rows per arm, null with no pass. */
  usdPerResolved: Record<ArmId, number | null>;
}

/** Graded rows of frozen units only. A contrast is shown when its Holm-adjusted p is below alpha and C is better. */
export function analyze(rows: Row[], prereg: Prereg): AbcReport {
  const frozen = new Set(prereg.units);
  const graded = rows.filter((r) => r.pass !== null && frozen.has(r.unit));
  const obs = graded.map(observation);
  const costObs = obs.filter((o) => o.costUsd > 0);
  const raw = prereg.contrasts.map(([t, c]) => pairedDifference(obs, t, c));
  const adjusted = holm(raw.map((r) => r.p));
  const contrasts = prereg.contrasts.map(([t, c], i): Contrast => {
    const d = raw[i] as ReturnType<typeof pairedDifference>;
    const cost = pairedDifference(costObs, t, c, (o) => Math.log(o.costUsd));
    const adjustedP = adjusted[i] as number;
    return {
      name: `${t}-${c}`,
      units: d.units,
      estimatePp: d.diff * 100,
      sePp: d.se * 100,
      rawP: d.p,
      adjustedP,
      shown: adjustedP < prereg.alpha && d.diff > 0,
      logCostRatio: cost.diff,
      logCostSe: cost.se,
    };
  });
  const usd = (arm: ArmId): number | null => {
    const mine = graded.filter((r) => r.arm === arm);
    const passes = mine.filter((r) => r.pass).length;
    return passes === 0 ? null : mine.reduce((s, r) => s + r.cost, 0) / passes;
  };
  return {
    graded: graded.length,
    contrasts,
    usdPerResolved: { A: usd('A'), B: usd('B'), C: usd('C') },
  };
}

const signed = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`;
const money = (x: number | null) => (x === null ? 'n/a' : x.toFixed(2));

/** One `verdict:` line per contrast, then the cost co-primary lines. */
export function reportLines(r: AbcReport, prereg: Prereg): string[] {
  const lines = r.contrasts.map(
    (c) =>
      `verdict: ${c.name} ${signed(c.estimatePp)} pp, clustered SE ${c.sePp.toFixed(1)} pp (${c.units} units), Holm p ${c.adjustedP.toFixed(4)}, ${c.shown ? 'shown' : 'not shown'} (alpha ${prereg.alpha}, MDE ${prereg.mdePp} pp)`,
  );
  for (const c of r.contrasts)
    lines.push(
      `cost: ${c.name} log ratio ${c.logCostRatio.toFixed(3)} (ratio ${Math.exp(c.logCostRatio).toFixed(2)}), clustered SE ${c.logCostSe.toFixed(3)}`,
    );
  const u = r.usdPerResolved;
  lines.push(
    `cost: USD per resolved task A ${money(u.A)}, B ${money(u.B)}, C ${money(u.C)}`,
  );
  return lines;
}
