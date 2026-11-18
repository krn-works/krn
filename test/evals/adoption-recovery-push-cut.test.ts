import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryScenario } from '../../evals/adoption/recovery.ts';

// KRN-12: the real drain, lane run and ship deliver a scratch outside repository; only the GitHub
// API (a stand-in at the gh boundary writing squash merges into the bare origin), the App mint and
// the worker are stand-ins. The point kills the whole batch once; the reruns must merge each task once.
test('a batch cut after the task closed in the worktree, before the push resumes to exactly one merge per task', async () => {
  const result = await recoveryScenario('b');
  assert.equal(result.pass, true, result.detail);
});
