import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// KRN-12: runs `krn prune` against real temporary git repositories with real linked worktrees.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const HOUR = 3_600_000;
// Fixture mtimes are set relative to one instant; prune's own clock reads them later.
const NOW = Date.now();

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** Sets the mtime of `path` and everything under it, deepest first, to `age` ago. */
function age(path: string, ms: number) {
  const at = new Date(NOW - ms);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) age(child, ms);
    else utimesSync(child, at, at);
  }
  utimesSync(path, at, at);
}

function write(path: string, text: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

function lane(repo: string, slug: string, old = true): string {
  const path = join(repo, '.krn', 'worktrees', slug);
  git(repo, 'worktree', 'add', '-q', '-b', slug, path, 'origin/main');
  if (old)
    utimesSync(
      join(path, '.git'),
      new Date(NOW - 3 * HOUR),
      new Date(NOW - 3 * HOUR),
    );
  return path;
}

function commit(cwd: string, file: string, text: string) {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-qm', file);
}

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-prune-')));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.name', 'prune test');
  git(repo, 'config', 'user.email', 'prune@example.invalid');
  git(repo, 'checkout', '-q', '-b', 'main');
  write(join(repo, '.gitignore'), '.krn/\n');
  commit(repo, 'seed.txt', 'seed');
  git(repo, 'push', '-q', '-u', 'origin', 'main');

  // Squash-merged: two lane commits land on main as one commit with another SHA.
  const squashed = lane(repo, 'squashed');
  commit(squashed, 'a.txt', 'a');
  commit(squashed, 'b.txt', 'b');
  git(repo, 'merge', '-q', '--squash', 'squashed');
  git(repo, 'commit', '-qm', 'squash of squashed');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  // Merged by fast-forward, but an agent left an untracked file behind.
  const untracked = lane(repo, 'untracked');
  commit(untracked, 'c.txt', 'c');
  git(repo, 'merge', '-q', '--ff-only', 'untracked');
  writeFileSync(join(untracked, 'notes.md'), 'left behind');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');

  const unmerged = lane(repo, 'unmerged');
  commit(unmerged, 'd.txt', 'd');
  // No commit yet: a lane whose session just started, and one whose task claim names it.
  lane(repo, 'fresh', false);
  lane(repo, 'claimed');
  write(
    join(repo, '.krn', 'task-claims', 't-abc1234.json'),
    JSON.stringify({ id: 't-abc1234', actor: 'lead', branch: 'claimed' }),
  );

  const runs = join(repo, '.krn', 'runs');
  write(
    join(runs, 'lanes', 'old-run', 'scratch', 'cache.bin'),
    'x'.repeat(4096),
  );
  write(join(runs, 'lanes', 'old-run', 'log.txt'), 'old');
  write(
    join(runs, 'lanes', 'finished-run', 'scratch', 'cache.bin'),
    'y'.repeat(2048),
  );
  write(join(runs, 'lanes', 'finished-run', 'log.txt'), 'recent');
  write(join(runs, 'lanes', 'kept-run', 'KEEP'), '');
  write(join(runs, 'lanes', 'kept-run', 'log.txt'), 'kept');
  write(
    join(runs, 'delivery-loop', 'session-continuity', 'handoff.md'),
    'handoff',
  );
  age(join(runs, 'lanes', 'old-run'), 10 * 24 * HOUR);
  age(join(runs, 'lanes', 'kept-run'), 10 * 24 * HOUR);
  age(join(runs, 'delivery-loop'), 10 * 24 * HOUR);
  age(join(runs, 'lanes', 'finished-run'), 2 * HOUR);
  return {
    repo,
    runs,
    wt: (slug: string) => join(repo, '.krn', 'worktrees', slug),
  };
}

function prune(repo: string, ...args: string[]) {
  return spawnSync('node', [cli, 'prune', '--root', repo, ...args], {
    encoding: 'utf8',
  });
}

test('krn prune --days 7 removes exactly the merged worktree, finished scratch and the old run', () => {
  const { repo, runs, wt } = fixture();

  const dry = prune(repo, '--days', '7', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would remove worktree \.krn\/worktrees\/squashed/);
  assert.match(
    dry.stdout,
    /^verdict: prune would free \d+ bytes \(worktrees 1\/\d+, scratch 1\/\d+, runs 1\/\d+\); kept 4 worktree\(s\)$/m,
  );
  assert.ok(existsSync(wt('squashed')), 'a dry run removes nothing');
  assert.ok(existsSync(join(runs, 'lanes', 'old-run')));

  const run = prune(repo, '--days', '7');
  assert.equal(run.status, 0, run.stderr);
  assert.match(
    run.stdout,
    /^verdict: prune freed \d+ bytes \(worktrees 1\/\d+, scratch 1\/2048, runs 1\/\d+\); kept 4 worktree\(s\)$/m,
  );
  assert.ok(!existsSync(wt('squashed')));
  assert.equal(
    spawnSync('git', [
      '-C',
      repo,
      'show-ref',
      '--verify',
      '--quiet',
      'refs/heads/squashed',
    ]).status,
    1,
  );
  assert.match(
    run.stdout,
    /kept worktree \.krn\/worktrees\/untracked: it holds 1 untracked file\(s\)/,
  );
  assert.match(
    run.stdout,
    /kept worktree \.krn\/worktrees\/unmerged: not merged into origin\/main/,
  );
  assert.match(
    run.stdout,
    /kept worktree \.krn\/worktrees\/fresh: added in the last two hours/,
  );
  assert.match(
    run.stdout,
    /kept worktree \.krn\/worktrees\/claimed: a task claim names its branch/,
  );
  for (const slug of ['untracked', 'unmerged', 'fresh', 'claimed'])
    assert.ok(existsSync(wt(slug)), slug);

  assert.ok(!existsSync(join(runs, 'lanes', 'old-run')));
  assert.ok(!existsSync(join(runs, 'lanes', 'finished-run', 'scratch')));
  assert.ok(
    existsSync(join(runs, 'lanes', 'finished-run', 'log.txt')),
    'a finished run keeps its records',
  );
  assert.ok(
    existsSync(join(runs, 'lanes', 'kept-run', 'log.txt')),
    'KEEP keeps an old run',
  );
  assert.ok(
    existsSync(join(runs, 'delivery-loop', 'session-continuity', 'handoff.md')),
    'the layout keeps handoffs',
  );
});

test('krn prune without --days deletes no run by age', () => {
  const { repo, runs } = fixture();
  const run = prune(repo);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(join(runs, 'lanes', 'old-run', 'log.txt')));
  assert.ok(
    !existsSync(join(runs, 'lanes', 'old-run', 'scratch')),
    'scratch of a finished run goes without --days',
  );
});
