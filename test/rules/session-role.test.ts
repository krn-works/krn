// A session without a lead brief stays in its checkout (t-r2nm8df). FR-40 runs a571f02e (agent-state-mask B),
// 3704c335 (clamp B), e2a289fe (dedupe B), 5ab5806b (slug B) and fc0cfa02 (range S) read the lead loop,
// created `.krn/worktrees/<name>` and committed there, so the scored checkout had no commit after base.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../../docs/program/repository-workflow.md', import.meta.url),
  'utf8',
);

test('the lead role needs an explicit brief; other sessions stay in their checkout', () => {
  assert.match(
    workflow,
    /A session is the lead only when the operator or its brief names that role or invokes `krn-lead`\./u,
  );
  assert.match(
    workflow,
    /Any other session works and commits in the checkout it was started in: it creates no worktree, branch or task, claims nothing, and skips the lead skills\./u,
  );
});
