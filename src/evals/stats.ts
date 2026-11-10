// Paired-binary statistics for FR-40 (ADR 0014 D20): an exact one-sided
// McNemar (sign) test on discordant units and the Bonett-Price adjusted Wald
// interval for a difference of paired proportions.

const logFactorials: number[] = [0];

function logFactorial(n: number): number {
  for (let i = logFactorials.length; i <= n; i += 1)
    logFactorials[i] = (logFactorials[i - 1] ?? 0) + Math.log(i);
  return logFactorials[n] ?? 0;
}

/** One-sided exact McNemar p-value: P(X ≥ wins) for X ~ Binomial(discordant, 1/2); 1 when nothing is discordant. */
export function mcnemarOneSided(discordant: number, wins: number): number {
  if (discordant === 0) return 1;
  let sum = 0;
  for (let j = wins; j <= discordant; j += 1)
    sum += Math.exp(
      logFactorial(discordant) -
        logFactorial(j) -
        logFactorial(discordant - j) -
        discordant * Math.LN2,
    );
  return Math.min(1, sum);
}

// Abramowitz and Stegun 7.1.26; absolute error below 1.5e-7.
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/** Standard normal quantile by bisection on the CDF. */
function normalQuantile(p: number): number {
  let low = -10;
  let high = 10;
  for (let i = 0; i < 100; i += 1) {
    const mid = (low + high) / 2;
    if ((1 + erf(mid / Math.SQRT2)) / 2 < p) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Bonett and Price (2012) adjusted Wald interval for p(x)−p(y) over `units`
 * paired units, where `wins` units pass only on x and `losses` only on y.
 */
export function bonettPrice(
  wins: number,
  losses: number,
  units: number,
  level: number,
): { lower: number; upper: number } {
  const n = units + 2;
  const p12 = (wins + 1) / n;
  const p21 = (losses + 1) / n;
  const difference = p12 - p21;
  const se = Math.sqrt(Math.max(0, p12 + p21 - difference ** 2) / n);
  const z = normalQuantile(1 - (1 - level) / 2);
  return {
    lower: Math.max(-1, difference - z * se),
    upper: Math.min(1, difference + z * se),
  };
}
