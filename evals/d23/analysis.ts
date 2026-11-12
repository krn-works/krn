// Repeated-run analysis for the D23 comparison: per-unit mean correctness per arm and the paired difference
// between two arms with a standard error clustered on the unit (the unit is the sampling unit, its repeats are not independent).
// Pure functions over observations; evals/d23/runs.ts produces the observations.

export interface Observation {
  unit: string;
  arm: string;
  run: number;
  /** Every hidden fail-to-pass test passed and nothing regressed; a run without a patch is incorrect. */
  correct: boolean;
  scopeClean: boolean;
  /** No patch and the session ended normally with an explanation. */
  refusal: boolean;
  costUsd: number;
}

export interface Paired {
  units: number;
  meanA: number;
  meanB: number;
  diff: number;
  se: number;
  ciLow: number;
  ciHigh: number;
  p: number;
}

const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

/** Mean of `pick` over each unit's runs of one arm. */
export function unitMeans(
  obs: Observation[],
  arm: string,
  pick: (o: Observation) => number = (o) => (o.correct ? 1 : 0),
): Map<string, number> {
  const by = new Map<string, number[]>();
  for (const o of obs) {
    if (o.arm !== arm) continue;
    by.set(o.unit, [...(by.get(o.unit) ?? []), pick(o)]);
  }
  return new Map([...by].map(([u, xs]) => [u, mean(xs)]));
}

/** Two-sided normal tail probability. */
function normalP(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  // Abramowitz-Stegun 7.1.26 erf approximation, absolute error below 1.5e-7.
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t *
    (0.254829592 +
      t *
        (-0.284496736 +
          t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return poly * Math.exp(-x * x);
}

/** Paired per-unit difference of arm A minus arm B over the units both arms have, clustered by unit, normal approximation. */
export function pairedDifference(
  obs: Observation[],
  a: string,
  b: string,
  pick?: (o: Observation) => number,
): Paired {
  const ma = unitMeans(obs, a, pick);
  const mb = unitMeans(obs, b, pick);
  const units = [...ma.keys()].filter((u) => mb.has(u));
  const d = units.map((u) => (ma.get(u) ?? 0) - (mb.get(u) ?? 0));
  const n = d.length;
  const diff = mean(d);
  const variance =
    n > 1 ? d.reduce((s, x) => s + (x - diff) ** 2, 0) / (n - 1) : 0;
  const se = Math.sqrt(variance / Math.max(n, 1));
  const p = se === 0 ? (diff === 0 ? 1 : 0) : normalP(diff / se);
  return {
    units: n,
    meanA: mean(units.map((u) => ma.get(u) ?? 0)),
    meanB: mean(units.map((u) => mb.get(u) ?? 0)),
    diff,
    se,
    ciLow: diff - 1.96 * se,
    ciHigh: diff + 1.96 * se,
    p,
  };
}

export interface ArmSecondary {
  runs: number;
  correct: number;
  scopeClean: number;
  refusals: number;
  costUsd: number;
  /** Total cost over correct runs; null when nothing was correct. */
  costPerCorrect: number | null;
}

export function armSecondary(obs: Observation[], arm: string): ArmSecondary {
  const mine = obs.filter((o) => o.arm === arm);
  const correct = mine.filter((o) => o.correct).length;
  const costUsd = mine.reduce((s, o) => s + o.costUsd, 0);
  return {
    runs: mine.length,
    correct,
    scopeClean: mine.filter((o) => o.scopeClean).length,
    refusals: mine.filter((o) => o.refusal).length,
    costUsd,
    costPerCorrect: correct ? costUsd / correct : null,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** The report: per-arm means, the paired differences against the baseline arm, and the secondary measures. */
export function report(
  obs: Observation[],
  arms: string[],
  baseline = 'P',
): string {
  const lines = [
    '| arm | units | mean correct | runs | scope-clean | refusals | $/correct |',
    '|--|--|--|--|--|--|--|',
  ];
  for (const arm of arms) {
    const m = unitMeans(obs, arm);
    const s = armSecondary(obs, arm);
    lines.push(
      `| ${arm} | ${m.size} | ${pct(mean([...m.values()]))} | ${s.runs} | ${s.scopeClean}/${s.runs} | ${s.refusals}/${s.runs} | ${s.costPerCorrect === null ? 'n/a' : s.costPerCorrect.toFixed(2)} |`,
    );
  }
  lines.push('');
  for (const arm of arms.filter((x) => x !== baseline)) {
    const r = pairedDifference(obs, arm, baseline);
    lines.push(
      `${arm} - ${baseline}: ${(r.diff * 100).toFixed(1)} pp over ${r.units} units, SE ${(r.se * 100).toFixed(1)} pp, 95% CI [${(r.ciLow * 100).toFixed(1)}, ${(r.ciHigh * 100).toFixed(1)}], p=${r.p.toFixed(3)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
