import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

test('lead rules bound parallel lanes to two isolated outcomes', () => {
  const rules = read('docs/program/lead-rules.md');
  const start = rules.indexOf('\n## Parallel lanes\n');
  assert.notEqual(start, -1, 'lead rules need a "## Parallel lanes" section');
  const end = rules.indexOf('\n## ', start + 1);
  const lanes = rules.slice(start, end === -1 ? undefined : end);
  for (const required of [
    'at most two lead lanes',
    '.krn/runs/delivery-loop/<outcome>/',
    '.krn/task-claims',
    'One writer per outcome',
    'review again',
    'main advanced',
  ])
    assert.ok(
      lanes.includes(required),
      `parallel lanes must state: ${required}`,
    );
});

test('the lead skill routes a second lane to the parallel lanes rule', () => {
  const skill = read('.agents/skills/krn-lead/SKILL.md');
  const resume = /^1\. \*\*Resume\.\*\*.*$/mu.exec(skill)?.[0] ?? '';
  assert.match(resume, /Parallel lanes/u);
  assert.match(skill, /bind: record\/PR head mismatch/u);
});
