import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readPack } from '../../src/brain/standards-cli.ts';
import { scanOf } from '../../src/brain/standards-review.ts';

// KRN-12: the real `krn standards review` entry on a generated repository with a base commit,
// a branch and a diff, so the merge-base, the git grep scans and the exit codes all run for real.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function git(root: string, ...args: string[]): void {
  const done = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
}

function put(root: string, name: string, content: string): void {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), content);
}

/** A node repository on main with one clean base commit, then branch `work`. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-review-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'a@b.c');
  git(root, 'config', 'user.name', 'a');
  put(root, 'package.json', '{"scripts":{"test":"node --test"}}\n');
  put(root, 'src/old.ts', 'export const old = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'checkout', '-q', '-b', 'work');
  return root;
}

function review(root: string) {
  return spawnSync(
    process.execPath,
    [cli, 'standards', 'review', '--root', root],
    {
      encoding: 'utf8',
      cwd: tmpdir(),
    },
  );
}

test('a planted violation in a changed file exits 1 naming file:line and the record', () => {
  const root = fixture();
  try {
    put(
      root,
      'src/new.ts',
      'export const a = 1;\n\nexport const b: any = 2;\n',
    );
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'work');
    const done = review(root);
    assert.equal(done.status, 1, done.stderr + done.stdout);
    assert.match(done.stderr, /VIOLATION src\/new\.ts:3 s-ts-no-any/);
    assert.match(done.stdout, /^FAIL standards review: 1 violation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a clean diff exits 0 and lists the records that apply to each changed file', () => {
  const root = fixture();
  try {
    put(root, 'src/new.ts', 'export const a: unknown = 1;\n');
    const done = review(root);
    assert.equal(done.status, 0, done.stderr + done.stdout);
    assert.match(done.stderr, /^src\/new\.ts: .*s-ts-no-any/m);
    assert.match(done.stdout, /^PASS standards review: 1 changed file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a violation in a file the diff does not touch is not reported', () => {
  const root = fixture();
  try {
    put(root, 'src/old.ts', 'export const old: any = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'bad base');
    git(root, 'checkout', '-q', '-B', 'main');
    git(root, 'checkout', '-q', '-b', 'other');
    put(root, 'src/new.ts', 'export const a = 1;\n');
    const done = review(root);
    assert.equal(done.status, 0, done.stderr + done.stdout);
    assert.doesNotMatch(done.stderr, /VIOLATION/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('review rejects a stray argument with the usage', () => {
  const done = spawnSync(process.execPath, [cli, 'standards', 'review', 'x'], {
    encoding: 'utf8',
  });
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /review/);
});

test('the pack holds git grep scans the review turns into line checks', () => {
  const scans = readPack().filter((standard) => scanOf(standard) !== undefined);
  assert.ok(scans.some((standard) => standard.id === 's-ts-no-any'));
});
