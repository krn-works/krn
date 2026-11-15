import assert from 'node:assert/strict';
import test from 'node:test';
import { capture } from '../receivers/capture.ts';

type Run = { name: string; conclusion: string; workflowName: string };

// Verbatim `gh pr view --json headRefOid,statusCheckRollup` of a PR shipped with
// plain `gh` calls: the push started the workflow and the aggregate `Check`
// finished with success on the exact head, which is the delivery transport proof.
const reply = JSON.parse(
  capture('fixtures/gh', 'pr-1112-head-rollup').streams.stdout?.toString(
    'utf8',
  ) ?? '',
) as { headRefOid: string; statusCheckRollup: Run[] };

test('a PR pushed and merged through plain gh has a successful aggregate Check on its head', () => {
  assert.match(reply.headRefOid, /^[0-9a-f]{40}$/u);
  const checks = reply.statusCheckRollup.filter((run) => run.name === 'Check');
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.conclusion, 'SUCCESS');
  assert.equal(checks[0]?.workflowName, 'CI');
});

test('the aggregate Check ran after every other job of its workflow concluded', () => {
  const others = reply.statusCheckRollup.filter((run) => run.name !== 'Check');
  assert.ok(others.length > 0);
  assert.ok(others.every((run) => run.conclusion === 'SUCCESS'));
});
