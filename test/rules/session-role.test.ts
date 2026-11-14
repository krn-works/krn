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

test('the lead role is tied to the krn-lead skill in one workflow paragraph', () => {
  const paragraph = workflow
    .split('\n\n')
    .find((block) => block.includes('`krn-lead`') && /lead/u.test(block));
  assert.ok(paragraph, 'workflow names the krn-lead role owner');
  assert.match(paragraph, /worktree/u);
});
