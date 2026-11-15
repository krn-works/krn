import assert from 'node:assert/strict';
import test from 'node:test';
import {
  namesRemedy,
  nextSteps,
  stepCommands,
  summarize,
} from '../../scripts/lib/first-day-walkthrough.ts';

const printed = `registered in the host registry of adopted repositories
next steps:
  1. commit the adoption files: git -C . add -A && git -C . commit -m "chore: adopt krn"
  2. merge them through a pull request on the default branch (never push the default branch directly)
  3. put krn on PATH for every agent session: the Stop hook refuses (exit 2) while \`command -v krn\` fails
  4. install the repository dependencies, then run \`krn repo contract\` to check the commands krn.json names
`;

test('the next steps are the numbered lines under the heading', () => {
  const steps = nextSteps(printed);
  assert.equal(steps.length, 4);
  assert.match(steps[0] as string, /^commit the adoption files/u);
  assert.deepEqual(nextSteps('no steps here\n'), []);
});

test('a step yields its backticked commands, else its colon tail, else none', () => {
  const steps = nextSteps(printed);
  assert.deepEqual(stepCommands(steps[0] as string), [
    'git -C . add -A && git -C . commit -m "chore: adopt krn"',
  ]);
  assert.deepEqual(stepCommands(steps[1] as string), []);
  assert.deepEqual(stepCommands(steps[2] as string), ['command -v krn']);
  assert.deepEqual(stepCommands(steps[3] as string), ['krn repo contract']);
});

test('a failure message names a remedy only when it says what to do', () => {
  assert.equal(namesRemedy('task does not exist'), false);
  assert.equal(namesRemedy('lane brief is empty'), false);
  assert.equal(namesRemedy('task does not exist; run krn task list'), true);
  assert.equal(namesRemedy('pass --stack ts|php|python'), true);
});

test('the summary exits 0 only when every step held', () => {
  const ok = summarize([{ name: 'a', ok: true, detail: '' }]);
  assert.equal(ok.exitCode, 0);
  assert.match(ok.text, /PASS 1 steps/u);
  const bad = summarize([
    { name: 'a', ok: true, detail: '' },
    { name: 'b', ok: false, detail: 'boom' },
  ]);
  assert.equal(bad.exitCode, 1);
  assert.match(bad.text, /FAIL b: boom/u);
});
