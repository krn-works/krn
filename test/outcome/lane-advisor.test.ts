import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { headlessArgs } from '../../src/harness/claude.ts';
import {
  armsOf,
  collectAdvisorTrial,
  renderAdvisorTrial,
} from '../../src/outcome/advisor-trial.ts';
import { advisorArm, laneAdvisor } from '../../src/outcome/lane-advisor.ts';
import { LANE_MARKER } from '../../src/outcome/lane-marker.ts';

const dir = fileURLToPath(
  new URL('../fixtures/first-push-green/', import.meta.url),
);
const captured = (name: string) => readFileSync(join(dir, name), 'utf8');

test('a brief line lane-advisor: fable opts the lane in; no line leaves it off', () => {
  assert.equal(laneAdvisor('Task: x\nlane-advisor: fable\n'), 'fable');
  assert.equal(laneAdvisor('lane-model: opus\nlane-advisor: fable'), 'fable');
  assert.equal(laneAdvisor('Advisor: on'), 'fable');
  assert.equal(laneAdvisor('lane-advisor: none'), undefined);
  assert.equal(laneAdvisor('Task: x'), undefined);
});

test('the headless session passes --advisor only for an opted-in lane', () => {
  const base = {
    prompt: 'p',
    model: 'opus',
    fallbackModel: 'sonnet',
    budgetUsd: 1,
  };
  const on = headlessArgs({ ...base, advisor: 'fable' } as never);
  assert.equal(on[on.indexOf('--advisor') + 1], 'fable');
  assert.equal(headlessArgs(base as never).includes('--advisor'), false);
});

test('the PR body line decides the arm; a non-lane body has none', () => {
  assert.equal(advisorArm(`${LANE_MARKER}\nAdvisor arm: fable\n`), 'advisor');
  assert.equal(advisorArm(`${LANE_MARKER}\nAdvisor arm: none\n`), 'none');
  assert.equal(advisorArm(`${LANE_MARKER}\n`), 'none');
  assert.equal(advisorArm('Advisor arm: fable\n'), undefined);
});

test('collect reads the arm from merged PR bodies, measures both arms and prints the numbers', async () => {
  const bodies: Record<number, string> = {
    1167: `${LANE_MARKER}\nAdvisor arm: fable\n`,
    1166: `${LANE_MARKER}\nAdvisor arm: none\n`,
    1165: 'not a lane PR',
  };
  assert.deepEqual(
    armsOf(
      Object.entries(bodies).map(([n, body]) => ({ number: Number(n), body })),
    ),
    { advisor: [1167], none: [1166] },
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
  const reports = await collectAdvisorTrial({ repo: 'o/r', run });
  assert.deepEqual(
    reports.map((r) => [r.arm, r.prs]),
    [
      ['advisor', 1],
      ['none', 1],
    ],
  );
  const text = renderAdvisorTrial(reports);
  assert.match(
    text,
    /^advisor: 1 PRs, first-push-green .*CI rounds per PR .*Fable cost per PR n\/a$/m,
  );
  assert.match(text, /^none: 1 PRs, first-push-green /m);
});
