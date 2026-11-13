import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkWeakTests } from '../../scripts/weak-tests.mjs';

const script = join(import.meta.dirname, '../../scripts/weak-tests.mjs');

const modify = (path: string, removed: string[], added: string[]) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    '',
  ].join('\n');
const remove = (path: string) =>
  `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n`;
const run = (diff: string, body = '', targets: string[] = []) =>
  checkWeakTests({
    diff,
    body,
    targetExists: (s: string) => targets.includes(s),
  });

test('removed assertion fails', () => {
  const r = run(modify('test/a.test.ts', ['  assert.equal(a, 1);'], []));
  assert.equal(r.ok, false);
  assert.match(r.findings[0] ?? '', /assertion/);
});

test('swapped assertion passes', () => {
  assert.equal(
    run(
      modify(
        'test/a.test.ts',
        ['assert.equal(a, 1);'],
        ['assert.equal(a, 2);'],
      ),
    ).ok,
    true,
  );
});

test('added skip, only and todo fail', () => {
  for (const line of ['skip', 'only', 'todo'].map(
    (kind) => `test.${kind}('x', f);`,
  ))
    assert.equal(run(modify('test/a.test.ts', [], [line])).ok, false, line);
});

test('test file deleted with target kept fails; target deleted passes', () => {
  assert.equal(run(remove('test/ci/foo.test.ts'), '', ['foo']).ok, false);
  assert.equal(run(remove('test/ci/foo.test.ts'), '', []).ok, true);
});

test('non-test files and plain changes pass', () => {
  assert.equal(run(modify('src/a.ts', ['assert(x)'], ['skip.only'])).ok, true);
  assert.equal(
    run(modify('test/a.test.ts', ['const a = 1;'], ['const a = 2;'])).ok,
    true,
  );
});

test('Weakens-tests line in the body overrides', () => {
  const diff = modify('test/a.test.ts', ['assert.ok(a);'], []);
  const r = run(diff, 'Summary\n\nWeakens-tests: covered by b.test.ts');
  assert.equal(r.ok, true);
  assert.equal(r.overridden, true);
  assert.equal(run(diff, 'Weakens-tests:').ok, false);
});

test('weak-tests --worktree reads uncommitted edits against the base', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weak-worktree-'));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
      { cwd: dir },
    );
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'test'));
  writeFileSync(
    join(dir, 'test/a.test.ts'),
    'assert.equal(a, 1);\nassert.equal(b, 2);\n',
  );
  git('add', '.');
  git('commit', '-qm', 'base');
  writeFileSync(join(dir, 'test/a.test.ts'), 'assert.equal(a, 1);\n');
  const result = spawnSync(process.execPath, [script, 'HEAD', '--worktree'], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /weak-tests: test\/a\.test\.ts: net 1 assertion\(s\) removed/u,
  );
});
