// Exact power and threshold reachability for the FR-40 paired design (ADR 0014 D20).
// Each unit (task or fix-commit cluster) yields one paired outcome: A pass/fail, B pass/fail.
// Discordant cells: P(A pass, B fail) = d, P(A fail, B pass) = d + effect.

const logFactorials: number[] = [0];

function logFactorial(n: number): number {
  for (let i = logFactorials.length; i <= n; i += 1) {
    logFactorials.push(logFactorials[i - 1] + Math.log(i));
  }
  return logFactorials[n];
}

function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

function logPow(p: number, k: number): number {
  return k === 0 ? 0 : k * Math.log(p);
}

function binomial(n: number, k: number, p: number): number {
  return Math.exp(logChoose(n, k) + logPow(p, k) + logPow(1 - p, n - k));
}

/** One-sided exact McNemar p-value: probability of at least `wins` B-only passes among `discordant`. */
export function mcnemarP(discordant: number, wins: number): number {
  let sum = 0;
  for (let j = wins; j <= discordant; j += 1)
    sum += binomial(discordant, j, 0.5);
  return sum;
}

/** Exact power of the one-sided exact McNemar test at `alpha` for `units` paired units. */
export function goPower(
  units: number,
  discordance: number,
  effect: number,
  alpha: number,
): number {
  const pDiscordant = 2 * discordance + effect;
  const pWin = (discordance + effect) / pDiscordant;
  let power = 0;
  for (let m = 0; m <= units; m += 1) {
    let critical = m + 1;
    for (let j = 0; j <= m; j += 1) {
      if (mcnemarP(m, j) <= alpha) {
        critical = j;
        break;
      }
    }
    if (critical > m) continue;
    const pM = binomial(units, m, pDiscordant);
    for (let j = critical; j <= m; j += 1) power += pM * binomial(m, j, pWin);
  }
  return power;
}

/** Smallest discordant count whose all-B outcome reaches p < alpha; null when none fits in `units`. */
export function goMinimumWins(units: number, alpha: number): number | null {
  for (let m = 1; m <= units; m += 1) if (mcnemarP(m, m) < alpha) return m;
  return null;
}

/**
 * Probability that the 90% CI upper bound of B−A falls below `bound` when the true
 * effect is zero (the KILL rule fires on a null arm). The interval is the Bonett–Price
 * adjusted Wald interval for paired proportions, which stays non-degenerate when
 * every unit is concordant.
 */
export function killProbability(
  units: number,
  discordance: number,
  bound: number,
  z: number,
): number {
  let probability = 0;
  for (let wins = 0; wins <= units; wins += 1) {
    for (let losses = 0; wins + losses <= units; losses += 1) {
      const ties = units - wins - losses;
      const logP =
        logFactorial(units) -
        logFactorial(wins) -
        logFactorial(losses) -
        logFactorial(ties) +
        logPow(discordance, wins) +
        logPow(discordance, losses) +
        logPow(1 - 2 * discordance, ties);
      const pWin = (wins + 1) / (units + 2);
      const pLoss = (losses + 1) / (units + 2);
      const diff = pWin - pLoss;
      const upper =
        diff + z * Math.sqrt((pWin + pLoss - diff * diff) / (units + 2));
      if (upper < bound) probability += Math.exp(logP);
    }
  }
  return probability;
}

/** Smallest unit count whose GO power reaches `target`, searched up to `limit`. */
export function unitsForPower(
  discordance: number,
  effect: number,
  alpha: number,
  target: number,
  limit: number,
): number | null {
  for (let n = 1; n <= limit; n += 1)
    if (goPower(n, discordance, effect, alpha) >= target) return n;
  return null;
}

export const round3 = (value: number): number =>
  Math.round(value * 1000) / 1000;
