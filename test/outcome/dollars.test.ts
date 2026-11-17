import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  collectDollars,
  joinDollars,
  renderDollars,
} from '../../src/outcome/dollars.ts';
import { summarize } from '../../src/outcome/first-push-green.ts';

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const turn = (id: string, command: string, at: string, inputTokens: number) =>
  line({
    type: 'assistant',
    timestamp: at,
    message: {
      id,
      role: 'assistant',
      model: 'claude-opus-5-5',
      usage: { input_tokens: inputTokens },
      content: [
        { type: 'tool_use', id: `tu-${id}`, name: 'Bash', input: { command } },
      ],
    },
  });
const day = '2026-11-01';
const pr = (n: number, hour: number) => ({
  number: n,
  title: `Slice ${n}`,
  createdAt: `${day}T${String(hour - 1).padStart(2, '0')}:00:00Z`,
  mergedAt: `${day}T${String(hour).padStart(2, '0')}:30:00Z`,
  mergeCommit: { oid: String(n).repeat(40).slice(0, 40) },
});
// Opus 5.5 input costs $4 per million tokens: #10 $4, #11 $8, #12 $2, #13 $2.
const spend = [
  [10, 9, 1_000_000],
  [11, 11, 2_000_000],
  [12, 13, 500_000],
  [13, 15, 500_000],
] as const;
const sha = (n: number) => String(n).padStart(40, '0');
const checkRun = (conclusion: string) => ({
  name: 'Check',
  status: 'completed',
  conclusion,
  started_at: `${day}T08:00:00Z`,
  completed_at: `${day}T08:05:00Z`,
});
// First Check per PR: #10 and #12 green, #11 red first, #13 never got one.
const firstCheck: Record<number, string | null> = {
  10: 'success',
  11: 'failure',
  12: 'success',
  13: null,
};

test('dollars per merged PR and per first-push-green PR join slice cost with the first Check of each PR', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ledger-dollars-'));
  try {
    await mkdir(join(root, 'transcripts'));
    await writeFile(
      join(root, 'transcripts/lead-1.jsonl'),
      line({ type: 'user', message: { role: 'user', content: 'go' } }) +
        spend
          .map(([n, hour, tokens]) =>
            turn(
              `m${n}`,
              `gh pr merge ${n} --auto`,
              `${day}T${String(hour).padStart(2, '0')}:15:00Z`,
              tokens,
            ),
          )
          .join(''),
    );
    const list = spend.map(([n, hour]) => pr(n, hour));
    const run = (cmd: string, args: string[]): string => {
      if (cmd === 'git') throw new Error('no repository');
      assert.equal(cmd, 'gh');
      const number = Number(args[2]);
      if (args[1] === 'list') return JSON.stringify(list);
      if (args[0] === 'pr' && args.includes('headRefName,createdAt'))
        return JSON.stringify({
          createdAt: `${day}T00:00:00Z`,
          headRefName: `slice-${number}`,
        });
      if (args[0] === 'pr' && args.includes('--jq'))
        return JSON.stringify([sha(number)]);
      if (args[0] === 'pr')
        return JSON.stringify({ commits: [{ oid: sha(number) }] });
      if (args[0] === 'run') return '[]';
      const n = Number(/commits\/0*(\d+)\/check-runs/.exec(args[1] ?? '')?.[1]);
      const first = firstCheck[n];
      if (!args.includes('--jq')) return '{}';
      return JSON.stringify(first ? [checkRun(first)] : []);
    };
    const report = await collectDollars({
      root,
      repo: 'krn-works/krn',
      transcripts: join(root, 'transcripts'),
      run,
    });
    assert.deepEqual(report, {
      merged: 4,
      unpriced: 0,
      firstPushGreen: 2,
      totalDollars: 16,
      perMerged: 4,
      perFirstPushGreen: 8,
    });
    const text = renderDollars(report);
    assert.match(text, /^Dollars per merged PR: \$4\.00 /m);
    assert.match(text, /^Dollars per first-push-green PR: \$8\.00 /m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a PR with an unknown cost is left out of both figures and counted; no green PR leaves its figure unknown', () => {
  const none = summarize([
    { number: 1, rounds: 1, first: 'failure', runOnly: 0 },
  ]);
  const report = joinDollars(
    [
      { number: 1, dollars: 3 },
      { number: 2, dollars: null },
    ],
    none,
  );
  assert.deepEqual(report, {
    merged: 1,
    unpriced: 1,
    firstPushGreen: 0,
    totalDollars: 3,
    perMerged: 3,
    perFirstPushGreen: null,
  });
  assert.match(renderDollars(report), /first-push-green PR: n\/a /);
  assert.equal(joinDollars([], summarize([])).perMerged, null);
});
