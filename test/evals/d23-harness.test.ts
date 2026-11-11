import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { harnessPlan, layHarness } from '../../evals/d23/harness.ts';

test('the replay harness keeps every file the merged change touched at the parent version', () => {
  const root = mkdtempSync(join(tmpdir(), 'd23-harness-'));
  const repo = join(root, 'repo');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const put = (f: string, body: string) => {
    mkdirSync(join(repo, f, '..'), { recursive: true });
    writeFileSync(join(repo, f), body);
  };
  try {
    mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@invalid');
    put('AGENTS.md', 'v1\n');
    put('scripts/claude/a.ts', 'v1\n');
    put('scripts/claude/old.ts', 'v1\n');
    put('src/x.ts', 'v1\n');
    git('add', '.');
    git('commit', '-qm', 'parent');
    const parent = git('rev-parse', 'HEAD');
    put('scripts/claude/a.ts', 'merged solution\n');
    git('commit', '-qam', 'merge');
    const merge = git('rev-parse', 'HEAD');
    put('AGENTS.md', 'v3\n');
    put('scripts/claude/a.ts', 'v3\n');
    put('scripts/claude/b.ts', 'v3\n');
    git('rm', '-q', 'scripts/claude/old.ts');
    git('add', '.');
    git('commit', '-qm', 'ref');
    const ref = git('rev-parse', 'HEAD');
    const plan = harnessPlan(repo, ref, parent, merge);
    assert.deepEqual(plan, {
      write: ['AGENTS.md', 'scripts/claude/b.ts'],
      remove: ['scripts/claude/old.ts'],
    });
    git('checkout', '-q', parent);
    layHarness(repo, repo, ref, plan);
    assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), 'v3\n');
    assert.equal(
      readFileSync(join(repo, 'scripts/claude/a.ts'), 'utf8'),
      'v1\n',
    );
    assert.equal(
      git('status', '--short'),
      'M AGENTS.md\n D scripts/claude/old.ts\n?? scripts/claude/b.ts'.trim(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
