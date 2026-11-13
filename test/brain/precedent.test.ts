import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  briefPaths,
  PRECEDENT_BUDGET,
  precedentSection,
} from '../../src/brain/precedent.ts';

function git(repo: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: repo, stdio: 'ignore' },
  );
}

function commit(repo: string, files: Record<string, string>, message: string) {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), body);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', message);
}

function fixture(): string {
  const repo = mkdtempSync(join(tmpdir(), 'precedent-'));
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, { 'src/a.ts': 'export const a = 1;\n' }, 'feat: a');
  commit(
    repo,
    {
      'src/a.ts': 'export const a = 2;\n',
      'test/a.test.ts':
        "import { a } from '../src/a.ts';\nassert.equal(code, 64);\n",
    },
    'fix: a exits 64',
  );
  git(repo, 'checkout', '-q', '-b', 'side');
  commit(
    repo,
    {
      'src/a.ts': 'export const a = 3;\n',
      'test/a.test.ts': 'assert.equal(code, 99);\n',
    },
    'wip: unmerged a',
  );
  git(repo, 'checkout', '-q', 'main');
  return repo;
}

test('brief paths come from the Scope line and backticked interface lines', () => {
  const brief =
    'Scope: src/a.ts, test/a.test.ts\n- `src/b.ts` exports `x`, `y`\nnot `src/c.ts`';
  assert.deepEqual(briefPaths(brief), ['src/a.ts', 'src/b.ts']);
});

test('the precedent lists HEAD commits, test hunks and importers, never an unmerged commit', () => {
  const repo = fixture();
  try {
    const text = precedentSection(repo, 'Scope: src/a.ts\n');
    assert.match(text, /fix: a exits 64/u);
    assert.match(text, /feat: a/u);
    assert.match(text, /\+assert\.equal\(code, 64\);/u);
    assert.match(text, /tests importing it: `test\/a\.test\.ts`/u);
    assert.doesNotMatch(text, /unmerged|code, 99/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the precedent respects the budget and a brief without paths gets none', () => {
  const repo = fixture();
  try {
    const small = precedentSection(repo, 'Scope: src/a.ts\n', 200);
    assert.ok(small.length <= 200);
    assert.ok(PRECEDENT_BUDGET >= small.length);
    assert.equal(precedentSection(repo, 'no paths here'), '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
