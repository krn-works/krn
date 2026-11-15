import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { closureRule, laneBriefText } from '../../src/cli/lane-brief.ts';

const root = new URL('../../', import.meta.url).pathname;
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');

test('KRN-11 and lanes.md agree that a lane closes its own task in its own PR', () => {
  const rule = (
    JSON.parse(read('spec/rules.json')) as {
      rules: { id: string; action: string }[];
    }
  ).rules.find((r) => r.id === 'KRN-11');
  assert.match(
    rule?.action ?? '',
    /a lane closes its own task record, inside its own worktree, in the PR that carries `Ticket:`/u,
  );
  assert.match(
    read('.agents/skills/delivery-lead/lanes.md'),
    /a lane closes only its own task, in its own pull request/u,
  );
  assert.match(read('AGENTS.md'), /a lane closes its own task record/u);
});

test('the lane brief for a task names the close command and the Ticket trailer', () => {
  const line = closureRule('t-abc1234');
  assert.match(line, /bin\/krn task close t-abc1234 --as done --note/u);
  assert.match(line, /Ticket: t-abc1234/u);
  assert.match(line, /Refs: t-abc1234/u);
});

test('laneBriefText appends the closure line only on request', () => {
  const brief = 'Task: x';
  const on = laneBriefText(root, brief, '2026-01-01', 't-abc1234', true);
  const off = laneBriefText(root, brief, '2026-01-01', 't-abc1234');
  assert.match(on, /bin\/krn task close t-abc1234 --as done/u);
  assert.doesNotMatch(off, /task close/u);
});
