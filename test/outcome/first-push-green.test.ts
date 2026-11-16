import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  collectFirstPushGreen,
  headRuns,
  prRounds,
  renderFirstPushGreen,
  summarize,
} from '../../src/outcome/first-push-green.ts';

const dir = fileURLToPath(
  new URL('../fixtures/first-push-green/', import.meta.url),
);
const captured = (name: string) => readFileSync(join(dir, name), 'utf8');

/** Replays the committed gh captures: the PR list and one Check reply per commit. */
const replay =
  (list = 'pr-list.json') =>
  (cmd: string, args: string[]): string => {
    assert.equal(cmd, 'gh');
    if (args[0] === 'run') {
      const branch = args[args.indexOf('--branch') + 1];
      const file = readdirSync(dir)
        .filter((f) => f.endsWith('-branch.json'))
        .find((f) => JSON.parse(captured(f)).headRefName === branch);
      return captured((file ?? '').replace(/^pr-(\d+)-branch/, 'runs-pr-$1'));
    }
    if (args[1] === 'list') return captured(list);
    if (args[1] === 'view' && args.includes('headRefName,createdAt'))
      return captured(`pr-${args[2]}-branch.json`);
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
    runOnly: 0,
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
    runOnly: 0,
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

type Reply = { status: string; conclusion: string; headSha?: string };
const json = (name: string) => JSON.parse(captured(name)) as unknown;

test('the measure over the captured gh output matches a direct count', async () => {
  const report = await collectFirstPushGreen({
    repo: 'krn-works/krn',
    limit: 8,
    run: replay(),
  });
  const numbers = (json('pr-list.json') as { number: number }[]).map(
    (p) => p.number,
  );
  assert.equal(report.prs.length, numbers.length);
  for (const n of numbers) {
    const commits = json(`pr-${n}-commits.json`) as string[];
    const judgedHeads = new Set(
      commits.filter((oid) =>
        (json(`check-runs-${oid}.json`) as Reply[]).some(
          (r) => r.status === 'completed' && r.conclusion !== 'cancelled',
        ),
      ),
    );
    const { createdAt } = json(`pr-${n}-branch.json`) as { createdAt: string };
    const runHeads = new Set(
      (
        json(`runs-pr-${n}.json`) as (Reply & {
          event: string;
          createdAt: string;
        })[]
      )
        .filter(
          (r) =>
            r.event === 'pull_request' &&
            r.createdAt >= createdAt &&
            r.status === 'completed' &&
            !['cancelled', 'skipped', 'stale'].includes(r.conclusion) &&
            !judgedHeads.has(r.headSha ?? ''),
        )
        .map((r) => r.headSha),
    );
    const pr = report.prs.find((p) => p.number === n);
    assert.equal(pr?.rounds, judgedHeads.size + runHeads.size);
    assert.equal(pr?.runOnly, runHeads.size);
  }
  assert.ok(report.measured > 0);
  assert.ok(report.meanRounds !== null && report.meanRounds >= 1);
  const text = renderFirstPushGreen(report);
  assert.match(text, /^First-push-green: \d+\.\d% \(\d+ of \d+ merged PRs/);
  assert.match(text, /CI rounds per PR .*: mean \d+\.\d\d/);
  assert.match(text, /Heads counted only from workflow runs .*: \d+/);
});

test('a PR whose first head was force-pushed away is not first-push-green', async () => {
  // PR 1156: its merged commit b97fb4f passed, but the first head c8cec81 failed and was force-pushed over.
  const commitsOnly = prRounds(
    1156,
    new Map([
      [
        'b97fb4fcf72f495a0e76f9d943b61af0a1dcb9b5',
        json(
          'check-runs-b97fb4fcf72f495a0e76f9d943b61af0a1dcb9b5.json',
        ) as unknown[],
      ],
    ]),
  );
  assert.equal(commitsOnly.first, 'success');
  const report = await collectFirstPushGreen({
    repo: 'krn-works/krn',
    run: replay('pr-list-force-pushed.json'),
  });
  assert.deepEqual(report.prs, [
    { number: 1156, rounds: 2, first: 'failure', runOnly: 1 },
  ]);
  assert.equal(report.green, 0);
  assert.equal(report.runOnlyHeads, 1);
});

test('a run of an earlier use of the branch name is not a head of the PR', () => {
  const old = {
    headSha: 'a',
    event: 'pull_request',
    status: 'completed',
    conclusion: 'failure',
    createdAt: '2026-11-15T00:00:00Z',
    startedAt: '2026-11-15T00:00:00Z',
  };
  assert.equal(headRuns([old], '2026-11-16T00:00:00Z').size, 0);
  assert.equal(
    headRuns([{ ...old, event: 'push' }], '2026-11-14T00:00:00Z').size,
    0,
  );
  assert.equal(headRuns([old], '2026-11-14T00:00:00Z').size, 1);
});
