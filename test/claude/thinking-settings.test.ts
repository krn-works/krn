import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Docs: https://code.claude.com/docs/en/sub-agents (frontmatter `effort`
// overrides the session level; there is no per-subagent thinking switch).
const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');
const field = (agent: string, key: string) =>
  new RegExp(`^${key}: (.+)$`, 'mu').exec(
    read(`.claude/agents/${agent}.md`).split('---')[1] ?? '',
  )?.[1];

test('read-only agents think at low effort', () => {
  for (const a of ['krn-reader', 'krn-radar', 'krn-research']) {
    assert.equal(field(a, 'effort'), 'low', a);
  }
});

test('worker lane keeps session effort; lead stays medium', () => {
  assert.equal(field('krn-lane', 'effort'), undefined);
  const s = JSON.parse(read('.claude/settings.json'));
  assert.equal(s.effortLevel, 'medium');
  assert.equal(s.env.CLAUDE_CODE_SUBAGENT_EFFORT, 'medium');
});
