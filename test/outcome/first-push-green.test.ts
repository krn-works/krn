import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  collectFirstPushGreen,
  prRounds,
  renderFirstPushGreen,
  summarize,
} from '../../src/outcome/first-push-green.ts';

const dir = fileURLToPath(
  new URL('../fixtures/first-push-green/', import.meta.url),
);
const captured = (name: string) => readFileSync(join(dir, name), 'utf8');

/** Replays the committed gh captures: the PR list and one Check reply per commit. */
const replay = (cmd: string, args: string[]): string => {
  assert.equal(cmd, 'gh');
  if (args[1] === 'list') return captured('pr-list.json');
  if (args[1] === 'view') return captured(`pr-${args[2]}-commits.json`);
  const sha = /commits\/([0-9a-f]{40})\/check-runs/.exec(args[1] ?? '')?.[1];
  return captured(`check-runs-${sha}.json`);
};

const run = (
  conclusion: string,
  started: string,
  status = 'completed',
): Record<string, string> => ({
  name: 'Check',
  status,
  conclusion,
  started_at: started,
  completed_at: started,
});

test('rounds count distinct pushed heads with a completed Check, the first head judges', () => {
  const checks = new Map<string, unknown[]>([
    ['b', [run('success', '2026-11-16T07:00:00Z')]],
    ['a', [run('failure', '2026-11-16T06:00:00Z')]],
    ['c', [run('cancelled', '2026-11-16T08:00:00Z')]],
    ['d', []],
  ]);
  assert.deepEqual(prRounds(7, checks), {
    number: 7,
    rounds: 2,
    first: 'failure',
  });
});

test('a rerun on the same head is one round and the first run decides', () => {
  const checks = new Map<string, unknown[]>([
    [
      'a',
      [
        run('success', '2026-11-16T06:10:00Z'),
        run('failure', '2026-11-16T06:00:00Z'),
      ],
    ],
  ]);
  assert.deepEqual(prRounds(1, checks), {
    number: 1,
    rounds: 1,
    first: 'failure',
  });
});

test('a PR with no completed Check is not measured', () => {
  const pending = run('', '2026-11-16T06:00:00Z', 'in_progress');
  const none = prRounds(2, new Map([['a', [pending]]]));
  const green = prRounds(
    3,
    new Map([['a', [run('success', '2026-11-16T06:00:00Z')]]]),
  );
  const s = summarize([none, green]);
  assert.equal(s.measured, 1);
  assert.equal(s.share, 1);
  assert.equal(s.meanRounds, 1);
  assert.equal(summarize([none]).share, null);
});

test('the measure over the captured gh output matches a direct count', async () => {
  const report = await collectFirstPushGreen({
    repo: 'krn-works/krn',
    limit: 8,
    run: replay,
  });
  const list = (
    JSON.parse(captured('pr-list.json')) as { number: number }[]
  ).map((p) => ({
    number: p.number,
    commits: (
      JSON.parse(captured(`pr-${p.number}-commits.json`)) as string[]
    ).map((oid) => ({ oid })),
  }));
  assert.equal(report.prs.length, list.length);
  const files = readdirSync(dir).filter((f) => f.startsWith('check-runs-'));
  assert.equal(files.length, list.flatMap((p) => p.commits).length);
  for (const pr of list) {
    const heads = pr.commits.filter((c) =>
      (
        JSON.parse(captured(`check-runs-${c.oid}.json`)) as {
          status: string;
          conclusion: string;
        }[]
      ).some((r) => r.status === 'completed' && r.conclusion !== 'cancelled'),
    );
    assert.equal(
      report.prs.find((p) => p.number === pr.number)?.rounds,
      heads.length,
    );
  }
  assert.ok(report.measured > 0);
  assert.ok(report.meanRounds !== null && report.meanRounds >= 1);
  const text = renderFirstPushGreen(report);
  assert.match(text, /^First-push-green: \d+\.\d% \(\d+ of \d+ merged PRs/);
  assert.match(text, /CI rounds per PR .*: mean \d+\.\d\d/);
});
