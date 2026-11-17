import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sessionEnvironment } from '../../src/cli/lane-run/environment.ts';
import { redCheckOf } from '../../src/cli/lane-run/red-check.ts';
import { renderPrBody } from '../../src/cli/pr-body.ts';
import { headlessArgs } from '../../src/harness/claude.ts';
import {
  collectEffortTrial,
  effortArmsOf,
  renderEffortTrial,
} from '../../src/outcome/effort-trial.ts';
import {
  effortArm,
  effortHistory,
  laneEffort,
  recordedEfforts,
} from '../../src/outcome/lane-effort.ts';
import { LANE_MARKER } from '../../src/outcome/lane-marker.ts';

const dir = fileURLToPath(
  new URL('../fixtures/first-push-green/', import.meta.url),
);
const captured = (name: string) => readFileSync(join(dir, name), 'utf8');

test('a lane turn runs at low effort by default and at high after a red Check', () => {
  assert.equal(laneEffort(false), 'low');
  assert.equal(laneEffort(true), 'high');
  assert.deepEqual(effortHistory([], false), ['low']);
  assert.deepEqual(effortHistory(['low'], true), ['low', 'high']);
  assert.deepEqual(effortHistory(['low', 'high'], true), [
    'low',
    'high',
    'high',
  ]);
  // A fresh lane starts over even when an older record is left behind.
  assert.deepEqual(effortHistory(['low', 'high'], false), ['low']);
});

test('the ship failure of exit 74 names a red Check, a green one does not', () => {
  assert.ok(redCheckOf('Check concluded failure on abcdef1234567 in run 99'));
  assert.equal(
    redCheckOf('Check concluded success on abcdef1234567 in run 99'),
    undefined,
  );
});

test('the headless session passes --effort only when a turn names one', () => {
  const base = {
    brief: 'p',
    settings: 's',
    model: 'sonnet',
    fallbackModel: 'haiku',
    budgetUsd: 1,
  };
  const low = headlessArgs({ ...base, effort: laneEffort(false) });
  assert.equal(low[low.indexOf('--effort') + 1], 'low');
  const high = headlessArgs({ ...base, effort: laneEffort(true) });
  assert.equal(high[high.indexOf('--effort') + 1], 'high');
  assert.equal(headlessArgs(base).includes('--effort'), false);
});

test('the effort of every turn reaches the PR body through the session environment', () => {
  const env = sessionEnvironment({}, '/tmp/c', {
    lane: 'l',
    effort: effortHistory(['low'], true).join(','),
  });
  assert.equal(env.KRN_LANE_EFFORT, 'low,high');
  const body = renderPrBody({
    task: { id: 't-x', title: 'x', body: [] } as never,
    commits: [],
    lane: true,
    effort: 'low,high',
  } as never);
  assert.deepEqual(recordedEfforts(body), ['low', 'high']);
  assert.equal(effortArm(body), 'under-policy');
});

test('the PR body line decides the policy arm; a non-lane body has none', () => {
  assert.equal(effortArm(`${LANE_MARKER}\nLane effort: low\n`), 'under-policy');
  assert.equal(
    effortArm(`${LANE_MARKER}\nAdvisor arm: none\n`),
    'before-policy',
  );
  assert.equal(effortArm('Lane effort: low\n'), undefined);
});

test('the report prints first-push-green and cost per PR for both arms on a fixture ledger', async () => {
  const bodies: Record<number, string> = {
    1167: `${LANE_MARKER}\nLane effort: low\n`,
    1166: `${LANE_MARKER}\nAdvisor arm: none\n`,
    1165: 'not a lane PR',
  };
  assert.deepEqual(
    effortArmsOf(
      Object.entries(bodies).map(([n, body]) => ({ number: Number(n), body })),
    ),
    { 'before-policy': [1166], 'under-policy': [1167] },
  );
  const run = (cmd: string, args: string[]): string => {
    assert.equal(cmd, 'gh');
    if (args[0] === 'run') {
      const branch = args[args.indexOf('--branch') + 1];
      const file = readdirSync(dir)
        .filter((f) => f.endsWith('-branch.json'))
        .find((f) => JSON.parse(captured(f)).headRefName === branch);
      return captured((file ?? '').replace(/^pr-(\d+)-branch/, 'runs-pr-$1'));
    }
    if (args[1] === 'list')
      return JSON.stringify(
        Object.entries(bodies).map(([n, body]) => ({
          number: Number(n),
          body,
        })),
      );
    if (args[1] === 'view' && args.includes('headRefName,createdAt'))
      return captured(`pr-${args[2]}-branch.json`);
    if (args[1] === 'view') return captured(`pr-${args[2]}-commits.json`);
    const sha = /commits\/([0-9a-f]{40})\/check-runs/.exec(args[1] ?? '')?.[1];
    return captured(`check-runs-${sha}.json`);
  };
  const reports = await collectEffortTrial({
    repo: 'o/r',
    run,
    costs: new Map([
      [1167, 0.17],
      [1166, 0.29],
    ]),
  });
  const text = renderEffortTrial(reports);
  assert.match(
    text,
    /^before-policy: 1 PRs, first-push-green .*cost per PR \$0\.29 \(1 priced\)$/m,
  );
  assert.match(
    text,
    /^under-policy: 1 PRs, first-push-green .*cost per PR \$0\.17 \(1 priced\)$/m,
  );
});
