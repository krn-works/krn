import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePrereg } from '../../evals/replay/abc.ts';
import { gatedAttempt } from '../../evals/replay/arm-session.ts';
import type { DrivenSession } from '../../evals/replay/session.ts';
import { parseSessionResult } from '../../evals/replay/session-result.ts';
import {
  LIST_PRICES,
  NO_CACHE_DISCOUNT,
  tokenCost,
  tokensOf,
} from '../../evals/replay/token-cost.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
// Verbatim `claude -p --output-format json` results of real lane sessions (costBasis "list").
const runs = join(repo, 'evals/fr40/results-lanes/fr40/runs');
// Verbatim stream-json captures of one session and of its `--resume` (test/evals/replay-attempt.test.ts).
const stream = (name: string) =>
  readFileSync(join(repo, 'test/fixtures/replay', `${name}.jsonl`), 'utf8');
const parse = (stdout: string) =>
  parseSessionResult(
    stdout,
    '',
    () => undefined,
    () => undefined,
    () => undefined,
  );

test('the fixed price vector reprices every captured session to the cost it reported', () => {
  const names = readdirSync(runs);
  let priced = 0;
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(runs, name, 'claude.json'), 'utf8');
    } catch {
      continue;
    }
    const reported = JSON.parse(text).total_cost_usd;
    const r = parse(text);
    assert.ok(r.tokens, name);
    const usd = tokenCost(r.tokens, LIST_PRICES);
    assert.ok(Math.abs(usd - reported) < 1e-9, `${name}: ${usd} ${reported}`);
    // The sensitivity vector removes the cache discount, so it never prices a session lower.
    assert.ok(tokenCost(r.tokens, NO_CACHE_DISCOUNT) >= usd, name);
    priced += 1;
  }
  assert.ok(priced >= 200, `${priced} captures priced`);
});

test('a resumed Claude session reports the whole session, so a re-prompted attempt is not charged twice', async () => {
  const first = stream('claude-stream');
  const resume = stream('claude-resume');
  const driven = (stdout: string): DrivenSession => ({
    result: parse(stdout),
    notStarted: false,
    timedOut: false,
    stdout,
    stderr: '',
  });
  const untested = driven(
    first.replace(/"make test"/gu, '"ls"').replace(/make test/gu, 'ls'),
  );
  const sessions = [untested, driven(resume)];
  const a = await gatedAttempt(
    'claude',
    'Fix it',
    { ms: 60_000, usd: 5 },
    async () => sessions.shift() as DrivenSession,
  );
  assert.equal(a.fields.reprompted, true);
  const whole = parse(resume);
  assert.equal(a.fields.cost, whole.cost);
  assert.deepEqual(a.fields.tokens, whole.tokens);
  assert.ok(whole.tokens);
  assert.ok(
    Math.abs(tokenCost(whole.tokens, LIST_PRICES) - (whole.cost ?? 0)) < 1e-9,
  );
});

test('cache writes split by lifetime, and a write without the split counts as 5-minute', () => {
  assert.deepEqual(
    tokensOf({
      'claude-sonnet-5-5': {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 100,
        cacheCreationEphemeral1hInputTokens: 40,
      },
      'claude-haiku-5-5': {
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationInputTokens: 5,
      },
    }),
    {
      input: 11,
      output: 22,
      cacheRead: 30,
      cacheWrite5m: 65,
      cacheWrite1h: 40,
    },
  );
  assert.equal(tokensOf({}), undefined);
  assert.equal(
    tokensOf({ m: { inputTokens: -1, outputTokens: 0 } }),
    undefined,
  );
});

test('the preregistration names the price vectors, the A/A arm and still lists its 70 units', () => {
  const text = readFileSync(join(repo, 'evals/replay/abc.prereg.md'), 'utf8');
  assert.equal(parsePrereg(text).units.length, 70);
  const vector = (key: string) =>
    new RegExp(`^${key}:[ \\t]*(.+)$`, 'mu').exec(text)?.[1]?.trim();
  const render = (p: typeof LIST_PRICES) =>
    `input ${p.input}, output ${p.output}, cache-read ${p.cacheRead}, cache-write-5m ${p.cacheWrite5m}, cache-write-1h ${p.cacheWrite1h}`;
  assert.equal(vector('cost-prices'), render(LIST_PRICES));
  assert.equal(vector('cost-sensitivity'), render(NO_CACHE_DISCOUNT));
  assert.match(vector('aa-arm') ?? '', /^A' \(a second copy of A\)/u);
  // The A/A replicate stays outside the confirmatory contrasts and their Holm family.
  assert.doesNotMatch(vector('contrasts') ?? '', /'/u);
});
