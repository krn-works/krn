import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string): string => readFileSync(`${root}${path}`, 'utf8');
const workflow = read('.github/workflows/mutation-samples.yml');
const runner = read('evals/mutation-samples/run.mjs');

test('clause 6: the workflow runs the sampler on a weekly cron and by dispatch', () => {
  assert.match(workflow, /^ {2}schedule:\n {4}- cron: '[^']+ \* \* 1'$/mu);
  assert.match(workflow, /^ {2}workflow_dispatch:/mu);
  assert.match(workflow, /node evals\/mutation-samples\/run\.mjs/u);
  assert.match(workflow, /killed\/total/u);
});

test('clause 6: the runner covers ledger, claims and state check and prints killed/total', () => {
  for (const file of [
    'src/outcome/ledger.ts',
    'src/task/claims.ts',
    'src/state/check.ts',
  ])
    assert.ok(runner.includes(`file: '${file}'`), file);
  assert.match(runner, /killed\/total: /u);
});

test('clause 7: the workflow stays out of the required Check aggregate', () => {
  assert.doesNotMatch(workflow, /^ {2}pull_request|^ {2}push:/mu);
  assert.doesNotMatch(workflow, /name: Check\b/u);
  assert.doesNotMatch(read('.github/workflows/ci.yml'), /mutation-samples/u);
});

test('clause 9: the workflow file names the runner and the schedule', () => {
  assert.ok(workflow.includes('evals/mutation-samples/run.mjs'));
  assert.ok(workflow.includes('cron:'));
});
