// Cost by token type (ADR 0021 point 12): a session's logged tokens priced by one fixed vector, so arms compare on what
// they spent, not on the price the harness happened to report; a second vector without the cache discount shows how
// much of a cost gap the cache explains.
import { z } from 'zod';

/** Tokens by type, summed over every model a session result names. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** USD per million tokens of each type. */
export type PriceVector = Readonly<TokenCounts>;

/**
 * Claude Sonnet 5.5 list prices (https://platform.claude.com/docs/en/about-claude/pricing): input 2, output 10, cache
 * read 0.05x input, 5-minute write 1.25x input, 1-hour write 2x input. Repricing every captured result reproduces its
 * `costUSD` (test/evals/replay-cost.test.ts). Every row is priced by this vector, whatever model it realized.
 */
export const LIST_PRICES: PriceVector = {
  input: 2,
  output: 10,
  cacheRead: 0.1,
  cacheWrite5m: 2.5,
  cacheWrite1h: 4,
};

/** The sensitivity vector: every cached or cache-written token at the input price. */
export const NO_CACHE_DISCOUNT: PriceVector = {
  input: 2,
  output: 10,
  cacheRead: 2,
  cacheWrite5m: 2,
  cacheWrite1h: 2,
};

const counter = z.number().finite().nonnegative();
const modelUsageSchema = z.record(
  z.string(),
  z
    .object({
      inputTokens: counter,
      outputTokens: counter,
      cacheReadInputTokens: counter.optional(),
      cacheCreationInputTokens: counter.optional(),
      cacheCreationEphemeral5mInputTokens: counter.optional(),
      cacheCreationEphemeral1hInputTokens: counter.optional(),
    })
    .loose(),
);

/**
 * The tokens of a result's `modelUsage`, summed over its models; undefined when it names none. A resumed Claude
 * session reports the whole session so far, not the run alone. Without the 5m/1h split every write counts as 5m.
 */
export function tokensOf(modelUsage: unknown): TokenCounts | undefined {
  const parsed = modelUsageSchema.safeParse(modelUsage);
  if (!parsed.success) return undefined;
  const models = Object.values(parsed.data);
  if (models.length === 0) return undefined;
  const sum: TokenCounts = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  };
  for (const m of models) {
    const written = m.cacheCreationInputTokens ?? 0;
    const w1h = m.cacheCreationEphemeral1hInputTokens ?? 0;
    sum.input += m.inputTokens;
    sum.output += m.outputTokens;
    sum.cacheRead += m.cacheReadInputTokens ?? 0;
    sum.cacheWrite1h += w1h;
    sum.cacheWrite5m += Math.max(0, written - w1h);
  }
  return sum;
}

/**
 * USD of `tokens` at `prices`. Prices are taken in thousandths of a USD per million tokens and summed as integers, so
 * equal spend from different token mixes is the same number, not one that differs by float rounding.
 */
export function tokenCost(tokens: TokenCounts, prices: PriceVector): number {
  const milli = (p: number) => Math.round(p * 1000);
  return (
    (tokens.input * milli(prices.input) +
      tokens.output * milli(prices.output) +
      tokens.cacheRead * milli(prices.cacheRead) +
      tokens.cacheWrite5m * milli(prices.cacheWrite5m) +
      tokens.cacheWrite1h * milli(prices.cacheWrite1h)) /
    1e9
  );
}
