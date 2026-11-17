import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type ArmReport,
  renderAdvisorTrial,
} from '../../src/outcome/advisor-trial.ts';
import { summarize } from '../../src/outcome/first-push-green.ts';

const unit = (number: number, first: string) => ({
  number,
  rounds: 1,
  first,
  runOnly: 0,
});
const arm = (name: ArmReport['arm'], firsts: string[], start: number) => ({
  arm: name,
  prs: firsts.length,
  result: summarize(firsts.map((f, i) => unit(start + i, f))),
  fableCostPerPr: null,
});

test('a 4-unit trial prints the per-unit table and flags the thin win', () => {
  const text = renderAdvisorTrial([
    arm('advisor', ['success', 'success', 'success', 'success'], 10),
    arm('none', ['success', 'failure', 'failure', 'failure'], 20),
  ]);
  assert.match(text, /^Per-unit results:$/m);
  assert.match(text, /^advisor #10 rounds 1 first success$/m);
  assert.match(text, /^none #23 rounds 1 first failure$/m);
  assert.match(
    text,
    /^thin win: advisor leads on first-push-green .*only 4 measured units \(fewer than 5\)$/m,
  );
});

test('the threshold is an option and a win on enough units is not flagged', () => {
  const reports = [
    arm('advisor', ['success', 'success', 'success', 'success'], 10),
    arm('none', ['success', 'failure', 'failure', 'failure'], 20),
  ];
  assert.doesNotMatch(renderAdvisorTrial(reports, { minUnits: 4 }), /thin win/);
  assert.match(
    renderAdvisorTrial(reports, { minUnits: 6 }),
    /fewer than 6\)$/m,
  );
});

test('a tie or an empty arm names no winner and prints no flag', () => {
  const tie = [arm('advisor', ['success'], 1), arm('none', ['success'], 2)];
  assert.doesNotMatch(renderAdvisorTrial(tie), /thin win/);
  const empty = [arm('advisor', ['success'], 1), arm('none', [], 2)];
  assert.doesNotMatch(renderAdvisorTrial(empty), /thin win/);
});
