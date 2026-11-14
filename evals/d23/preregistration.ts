// The preregistration gate for the D23 confirmatory K vs PB run, and the power formulas its file states.
// The run starts only from a preregistration file that is committed unchanged and whose sha256 the caller names.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 erf, absolute error below 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t *
    (0.254829592 +
      t *
        (-0.284496736 +
          t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const upper = (poly * Math.exp(-x * x)) / 2;
  return z >= 0 ? 1 - upper : upper;
}

/** Standard normal quantile by bisection on normalCdf. */
export function normalQuantile(p: number): number {
  let lo = -10;
  let hi = 10;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Power of the two-sided paired test at `alpha` for a true difference `delta`, n units, per-unit SD `sd` of the paired difference:
 * se = sd / sqrt(n); power = Phi(delta/se - z(1-alpha/2)) + Phi(-delta/se - z(1-alpha/2)).
 */
export function pairedPower(
  n: number,
  delta: number,
  sd: number,
  alpha = 0.05,
): number {
  const se = sd / Math.sqrt(n);
  const zc = normalQuantile(1 - alpha / 2);
  return normalCdf(delta / se - zc) + normalCdf(-delta / se - zc);
}

/** Units for the two-sided test to reach `power`: n = ((z(1-alpha/2) + z(power)) * sd / delta)^2, rounded up. */
export function unitsForPower(
  delta: number,
  sd: number,
  power = 0.8,
  alpha = 0.05,
): number {
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
  return Math.ceil(((z * sd) / delta) ** 2);
}

/**
 * Power of the two one-sided equivalence test (TOST, level alpha, margin m) when the true difference is `delta`:
 * equivalence is declared when the 100(1-2*alpha)% CI lies inside (-m, +m), that is |d_hat| < m - z(1-alpha)*se.
 * power = Phi((m - z*se - delta)/se) - Phi((-m + z*se - delta)/se) when m > z*se, else 0.
 */
export function equivalencePower(
  n: number,
  margin: number,
  delta: number,
  sd: number,
  alpha = 0.05,
): number {
  const se = sd / Math.sqrt(n);
  const bound = margin - normalQuantile(1 - alpha) * se;
  if (bound <= 0) return 0;
  return Math.max(
    0,
    normalCdf((bound - delta) / se) - normalCdf((-bound - delta) / se),
  );
}

/** Units for TOST to reach `power` at true difference 0: n = ((z(1-alpha) + z(1-(1-power)/2)) * sd / m)^2, rounded up. */
export function equivalenceUnits(
  margin: number,
  sd: number,
  power = 0.8,
  alpha = 0.05,
): number {
  const z = normalQuantile(1 - alpha) + normalQuantile(1 - (1 - power) / 2);
  return Math.ceil(((z * sd) / margin) ** 2);
}

export class PreregistrationError extends Error {}

const git = (dir: string, args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/**
 * Refuse unless `file` exists, is tracked and identical to HEAD, and its sha256 equals `expectedSha256`.
 * Returns the verified hash.
 */
export function requirePreregistration(
  file: string,
  expectedSha256: string,
): string {
  const path = resolve(file);
  if (!file || !existsSync(path))
    throw new PreregistrationError(
      `confirmatory run refused: preregistration file not found: ${file || '(none given)'}`,
    );
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(expectedSha256 ?? ''))
    throw new PreregistrationError(
      'confirmatory run refused: --prereg-sha256 must be the 64 hex digits of the preregistration sha256',
    );
  if (actual !== expectedSha256)
    throw new PreregistrationError(
      `confirmatory run refused: preregistration sha256 is ${actual}, not ${expectedSha256}`,
    );
  const dir = dirname(path);
  try {
    git(dir, ['ls-files', '--error-unmatch', path]);
    if (git(dir, ['status', '--porcelain', '--', path]).trim() !== '')
      throw new PreregistrationError('uncommitted changes');
  } catch (e) {
    throw new PreregistrationError(
      `confirmatory run refused: preregistration file is not committed unchanged (${e instanceof PreregistrationError ? e.message : 'untracked'})`,
    );
  }
  return actual;
}
