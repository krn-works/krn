import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { changedFiles, lintable, selectTests } from '../scripts/fast-check.ts';

const tests = new Map([
  [
    'test/task/claim.test.ts',
    "import { claim } from '../../src/task/claim.ts';",
  ],
  ['test/cli.test.ts', "import { main } from '../src/cli/main.ts';"],
  ['test/other.test.ts', "import x from '../src/task/claimant.ts';"],
]);

test('fast check selects changed tests, same-stem tests and importers of a changed module', () => {
  assert.deepEqual(selectTests(['src/task/claim.ts'], tests), [
    'test/task/claim.test.ts',
  ]);
  assert.deepEqual(selectTests(['src/cli/main.ts'], tests), [
    'test/cli.test.ts',
  ]);
  assert.deepEqual(selectTests(['test/other.test.ts', 'docs/x.md'], tests), [
    'test/other.test.ts',
  ]);
  assert.deepEqual(selectTests(['docs/x.md'], tests), []);
});

test('fast check lints code files and skips task records and prose', () => {
  assert.deepEqual(
    lintable(['a.ts', 'tasks/t-1.json', 'docs/x.md', 'b.mjs', 'c.json']),
    ['a.ts', 'b.mjs', 'c.json'],
  );
});

test('fast check lists committed, modified and untracked files against the base', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fast-check-'));
  const git = (...args: string[]) =>
    assert.equal(
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: dir,
      }).status,
      0,
    );
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.ts'), '1');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'work');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/b.ts'), '1');
  git('add', '.');
  git('commit', '-qm', 'work');
  writeFileSync(join(dir, 'a.ts'), '2');
  writeFileSync(join(dir, 'new.ts'), '1');
  assert.deepEqual(changedFiles(dir), ['a.ts', 'new.ts', 'src/b.ts']);
});
