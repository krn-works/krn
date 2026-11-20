import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type test from 'node:test';
import { recordShip } from '../../src/repo/ship-record.ts';
import { addPendingTask } from '../../src/task/pending.ts';

// KRN-12: real git; the ship record is written by the writer `krn pr ship` uses.
export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

const task = (id: string) =>
  `${JSON.stringify({ id, status: 'open', resolution: null, created: '2026-11-20', priority: 2, title: 'Lane task', after: [], body: ['Outcome: o'] }, null, 2)}\n`;

/** A lane `slug` that committed once, merged on origin/main and has a ship record; `keep` leaves its worktree. */
function mergedLane(repo: string, slug: string, keep: boolean): void {
  const tree = join(repo, '.krn', 'worktrees', slug);
  git(repo, 'worktree', 'add', '-q', '-b', slug, tree);
  writeFileSync(join(tree, `${slug}.txt`), slug);
  git(tree, 'add', '.');
  git(tree, 'commit', '-qm', `feat(lane): ${slug}`);
  const head = git(tree, 'rev-parse', 'HEAD');
  git(repo, 'merge', '-q', '--no-ff', '-m', `merge ${slug}`, head);
  git(repo, 'push', '-q', 'origin', 'main');
  recordShip(repo, { branch: slug, sha: git(repo, 'rev-parse', 'HEAD'), head });
  // Old enough that lane prune may remove the worktree it finds merged.
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(join(repo, '.krn', 'runs', 'ship', `${slug}.json`), old, old);
  if (keep) return;
  git(repo, 'worktree', 'remove', '--force', tree);
  git(repo, 'branch', '-D', slug);
}

export function startFixture(t: test.TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-start-refusal-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.name', 'lane test');
  git(repo, 'config', 'user.email', 'lane@example.invalid');
  git(repo, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(repo, 'tasks'));
  writeFileSync(join(repo, 'tasks', 't-abc1234.json'), task('t-abc1234'));
  writeFileSync(join(repo, '.gitignore'), '.krn/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'seed');
  git(repo, 'push', '-q', 'origin', 'main');
  // The slug a new lane reuses, and a finished sibling lane prune would remove.
  mergedLane(repo, 'reused', false);
  mergedLane(repo, 'finished', true);
  // A record waiting on the publish ref must survive too.
  addPendingTask(repo, 't-pend001', task('t-pend001'));
  return { repo };
}
