import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { titleProblem } from '../../scripts/commit-title.ts';

test('conventional titles pass', () => {
  for (const title of [
    'feat(roadmap): let parallel lanes close rows without conflicts (t-r3k9f7m)',
    'fix: bound every GitHub call (t-xtmc5e6)',
    'refactor(cli)!: drop the deliver command',
    'test(unzip_http): cover warning writing to stderr (t-0x3pmx6)',
    'fix(lib.core): keep the dotted module name (t-0x3pmx6)',
    'fix(web): a cached page no longer shows stale prices',
    'fix(web): a cached page no longer shows stale prices (#38510)',
    `feat(ci): ${'x'.repeat(62)} (t-abc1234) (#12)`,
    'fix(ci): CI reruns a flaky shard once',
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
    'Update stuff',
    'fix(web): Cached pages no longer show stale prices',
    'fix(web): a cached page no longer shows stale prices.',
    `feat(ci): ${'x'.repeat(91)} (t-abc1234)`,
  ])
    assert.notEqual(titleProblem(title), undefined, title);
});

test('a refusal names the rule and the expected form', () => {
  assert.match(
    titleProblem(`feat: ${'y'.repeat(96)}`) ?? '',
    /102 characters, at most 100 .*type\(scope\): outcome/u,
  );
  assert.match(titleProblem('Update stuff') ?? '', /type\(scope\): outcome/u);
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
