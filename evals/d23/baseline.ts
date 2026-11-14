// Whether a unit's K baseline is red: the parent tree, with the tests its merged change selects (the ones
// that already exist at the parent) failing before the worker writes a line. Such a unit measures the
// pre-existing failure, not the arm, so selection drops it for every arm.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relatedTests } from '../../src/hook/stop.ts';

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

const lines = (out: string) => out.split('\n').filter(Boolean);
const isTestFile = (f: string) => /^test\/.*\.test\.[a-z]+$/u.test(f);

/** Test files at the parent that the merged change selects: its changed tests and tests importing its sources. */
export function baselineTests(
  changed: string[],
  parentTests: Map<string, string>,
): string[] {
  return relatedTests(
    changed.filter((f) => !f.startsWith('tasks/')),
    parentTests,
  ).filter((f) => parentTests.has(f));
}

/** True when the related tests at `parent` fail; a parent with no related test is green. */
export function redAtParent(repo: string, parent: string, merge: string) {
  const changed = lines(git(repo, 'diff', '--name-only', parent, merge));
  const dir = mkdtempSync(join(tmpdir(), 'd23-baseline-'));
  try {
    git(repo, 'worktree', 'add', '--detach', dir, parent);
    // A lane worktree has no node_modules of its own; the main checkout holds them.
    const modules = join(
      repo.split('/.krn/worktrees/')[0] ?? repo,
      'node_modules',
    );
    if (existsSync(modules)) symlinkSync(modules, join(dir, 'node_modules'));
    const tests = new Map<string, string>();
    for (const f of lines(git(dir, 'ls-files')))
      if (isTestFile(f)) tests.set(f, readFileSync(join(dir, f), 'utf8'));
    const files = baselineTests(changed, tests);
    if (files.length === 0) return false;
    const run = spawnSync(process.execPath, ['--test', ...files], {
      cwd: dir,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      stdio: 'ignore',
      timeout: 600_000,
    });
    return run.status !== 0;
  } finally {
    try {
      git(repo, 'worktree', 'remove', '--force', dir);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
    git(repo, 'worktree', 'prune');
  }
}
