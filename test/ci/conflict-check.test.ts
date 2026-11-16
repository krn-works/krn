import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { run } from '../../src/ci/command.ts';
import { assertNoConflict } from '../../src/ci/conflict-check.ts';

// KRN-12: a real temporary git repository and the real git merge-tree.
function git(cwd: string, ...args: string[]): string {
  const result = run(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    cwd,
    cwd,
  );
  assert.equal(result.code, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function edit(cwd: string, file: string, text: string, message: string) {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', message);
}

function setup(): { work: string; main: string } {
  const root = mkdtempSync(join(tmpdir(), 'conflict-check-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const main = join(root, 'main');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, work);
  mkdirSync(join(work, 'src'), { recursive: true });
  writeFileSync(join(work, 'src/a.ts'), '// a\n');
  writeFileSync(join(work, 'src/b.ts'), '// b\n');
  git(work, 'checkout', '-q', '-b', 'main');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'base');
  git(work, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', origin, main);
  return { work, main };
}

test('a branch that merges cleanly into the moved base passes and stays untouched', () => {
  const { work, main } = setup();
  git(work, 'checkout', '-q', '-b', 'lane');
  edit(work, 'src/b.ts', '// b lane\n', 'lane edits b');
  edit(main, 'src/c.ts', '// c main\n', 'main adds c');
  git(main, 'push', '-q', 'origin', 'main');
  git(work, 'fetch', '-q', 'origin', 'main');
  const before = git(work, 'rev-parse', 'HEAD');

  assert.doesNotThrow(() => assertNoConflict(work, 'main', run));
  assert.equal(git(work, 'rev-parse', 'HEAD'), before);
  assert.equal(git(work, 'status', '--porcelain'), '');
});

test('a conflict exits 76 naming the file and leaves the work tree untouched', () => {
  const { work, main } = setup();
  git(work, 'checkout', '-q', '-b', 'lane');
  edit(work, 'src/a.ts', '// a lane\n', 'lane edits a');
  edit(main, 'src/a.ts', '// a main\n', 'main edits a');
  git(main, 'push', '-q', 'origin', 'main');
  git(work, 'fetch', '-q', 'origin', 'main');
  const before = git(work, 'rev-parse', 'HEAD');

  assert.throws(
    () => assertNoConflict(work, 'main', run),
    (error: Error & { exitCode?: number }) =>
      error.exitCode === 76 && /src\/a\.ts/u.test(error.message),
  );
  assert.equal(git(work, 'rev-parse', 'HEAD'), before);
  assert.equal(git(work, 'status', '--porcelain'), '');
});
