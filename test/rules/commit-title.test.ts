import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { titleProblem } from '../../scripts/commit-title.ts';

test('conventional titles pass', () => {
  for (const title of [
    'feat(roadmap): let parallel lanes close rows without conflicts (t-r3k9f7m)',
    'fix: bound every GitHub call (t-xtmc5e6)',
    'refactor(cli)!: drop the deliver command',
  ])
    assert.equal(titleProblem(title), undefined, title);
});

// Regression: every title merged after #400 used this plain form.
test('plain and malformed titles fail', () => {
  for (const title of [
    'Let parallel lanes close roadmap rows without merge conflicts (t-r3k9f7m)',
    'feature: add a thing',
    'fix(CI): upper-case scope',
    'fix:missing space',
    'fix(ci): ',
  ])
    assert.notEqual(titleProblem(title), undefined, title);
});

test('CI checks the pull request title, re-run on title edits', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /node scripts\/commit-title\.ts/u);
  assert.match(
    workflow,
    /PR_TITLE: \$\{\{ github\.event\.pull_request\.title \}\}/u,
  );
  assert.match(workflow, /types: \[opened, synchronize, reopened, edited\]/u);
});
