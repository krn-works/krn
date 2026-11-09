// Instruction bytes ratchet (t3code agentContextBudget): growth is a reviewed edit of spec/context-budget.json.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const budgetFile = join(root, 'spec/context-budget.json');
const budget = JSON.parse(readFileSync(budgetFile, 'utf8')) as {
  files: Record<string, number>;
};

function surfaces(): string[] {
  const found = ['AGENTS.md'];
  for (const entry of readdirSync(join(root, 'docs/program')))
    if (entry.endsWith('.md')) found.push(`docs/program/${entry}`);
  const skills = join(root, '.agents/skills');
  for (const skill of readdirSync(skills))
    for (const file of readdirSync(join(skills, skill)))
      if (file.endsWith('.md') && statSync(join(skills, skill, file)).isFile())
        found.push(`.agents/skills/${skill}/${file}`);
  return found.sort();
}

test('agent instruction bytes stay within the recorded budget', () => {
  const actual = surfaces();
  const unbudgeted = actual.filter((file) => !(file in budget.files));
  assert.deepEqual(
    unbudgeted,
    [],
    'new instruction file: add its size to spec/context-budget.json in the same PR and say why',
  );
  const stale = Object.keys(budget.files).filter(
    (file) => !actual.includes(file),
  );
  assert.deepEqual(stale, [], 'removed file still budgeted: delete its entry');
  const grown = actual
    .map((file) => ({
      file,
      bytes: statSync(join(root, file)).size,
      limit: budget.files[file] ?? 0,
    }))
    .filter(({ bytes, limit }) => bytes > limit)
    .map(({ file, bytes, limit }) => `${file}: ${bytes} > ${limit}`);
  assert.deepEqual(
    grown,
    [],
    'instruction text grew: shrink it, or raise spec/context-budget.json with the reason in the PR body',
  );
});

// Lanes editing different skills bump their budgets in parallel; git
// conflicts on adjacent changed lines, so a blank line separates entries
// (the t-7g0prdk lane rebased on this file on 2026-11-09).
test('budget entries are blank-line separated so parallel bumps merge', () => {
  const text = readFileSync(budgetFile, 'utf8');
  assert.doesNotMatch(text, /\d,\n {4}"/u, 'separate entries with a blank line');
  const dir = mkdtempSync(join(tmpdir(), 'budget-merge-'));
  try {
    const bump = (from: string, to: string) => text.replace(from, to);
    const [first, second] = Object.entries(budget.files);
    assert.ok(first && second);
    const line = ([file, bytes]: [string, number], add: number) =>
      [`"${file}": ${bytes},`, `"${file}": ${bytes + add},`] as const;
    writeFileSync(join(dir, 'base'), text);
    writeFileSync(join(dir, 'ours'), bump(...line(first, 1)));
    writeFileSync(join(dir, 'theirs'), bump(...line(second, 1)));
    const merge = spawnSync('git', ['merge-file', '-p', 'ours', 'base', 'theirs'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(merge.status, 0, merge.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
