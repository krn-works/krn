import type { TokenCounts } from '../../evals/replay/token-cost.ts';

/** Tokens that cost `usd` at the list vector and at the sensitivity vector alike: input tokens only (2 USD per million). */
export const inputOnly = (usd: number): TokenCounts => ({
  input: (usd / 2) * 1e6,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
});
