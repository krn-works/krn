import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// KRN-12: runs `krn lane start` against real temporary git repositories.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-lane-')));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.name', 'lane test');
  git(repo, 'config', 'user.email', 'lane@example.invalid');
  git(repo, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(repo, 'tasks'));
  writeFileSync(
    join(repo, 'tasks', 't-abc1234.json'),
    `${JSON.stringify(
      {
        id: 't-abc1234',
        status: 'open',
        resolution: null,
        created: '2026-11-09',
        priority: 3,
        title: 'Lane task',
        after: [],
        body: ['Outcome: o'],
      },
      null,
      2,
    )}\n`,
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'seed');
  git(repo, 'push', '-q', 'origin', 'main');
  // origin moves ahead of the local checkout: the lane must start from it.
  const other = join(base, 'other');
  git(base, 'clone', '-q', origin, other);
  git(other, 'config', 'user.name', 'lane test');
  git(other, 'config', 'user.email', 'lane@example.invalid');
  writeFileSync(join(other, 'newer.txt'), 'x');
  git(other, 'add', '.');
  git(other, 'commit', '-qm', 'newer');
  git(other, 'push', '-q', 'origin', 'main');
  return { base, repo };
}

function lane(repo: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, 'lane', ...args], {
    cwd: repo,
    encoding: 'utf8',
  });
}

test('lane start fetches origin main, creates the worktree and claims the task', () => {
  const { base, repo } = fixture();
  try {
    const result = lane(repo, 'start', 'my-lane', '--task', 't-abc1234');
    assert.equal(result.status, 0, result.stderr);
    const path = join(repo, '.krn', 'worktrees', 'my-lane');
    assert.equal(result.stdout, `${path}\nmy-lane\n`);
    assert.ok(existsSync(join(path, 'newer.txt')));
    assert.equal(git(path, 'branch', '--show-current'), 'my-lane');
    const claim = readFileSync(
      join(repo, '.krn', 'task-claims', 't-abc1234.json'),
      'utf8',
    );
    assert.match(claim, /my-lane/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lane start rejects a duplicate slug and a bad slug with exit 64', () => {
  const { base, repo } = fixture();
  try {
    assert.equal(lane(repo, 'start', 'dup').status, 0);
    const again = lane(repo, 'start', 'dup');
    assert.equal(again.status, 64);
    assert.match(again.stderr, /dup already exists/u);
    assert.equal(again.stdout, '');
    assert.equal(lane(repo, 'start', 'Bad Slug').status, 64);
    assert.equal(lane(repo, 'stop').status, 64);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lane start rolls back the worktree when the claim fails', () => {
  const { base, repo } = fixture();
  try {
    const result = lane(repo, 'start', 'ghost', '--task', 't-nope999');
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(repo, '.krn', 'worktrees', 'ghost')), false);
    assert.equal(git(repo, 'branch', '--list', 'ghost'), '');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

const record = (id: string) =>
  `${JSON.stringify({ id, status: 'open', resolution: null, created: '2026-11-09', priority: 3, title: 'New', after: [], body: ['Outcome: o'] }, null, 2)}\n`;

test('lane start moves a task record that is not yet committed into the worktree', () => {
  const { base, repo } = fixture();
  try {
    const file = join(repo, 'tasks', 't-new1234.json');
    writeFileSync(file, record('t-new1234'));
    const result = lane(repo, 'start', 'carry', '--task', 't-new1234');
    assert.equal(result.status, 0, result.stderr);
    const moved = join(
      repo,
      '.krn',
      'worktrees',
      'carry',
      'tasks',
      't-new1234.json',
    );
    assert.equal(readFileSync(moved, 'utf8'), record('t-new1234'));
    assert.equal(existsSync(file), false);
    assert.ok(existsSync(join(repo, '.krn', 'task-claims', 't-new1234.json')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lane start refuses a task record tracked locally but absent from origin main', () => {
  const { base, repo } = fixture();
  try {
    writeFileSync(join(repo, 'tasks', 't-loc1234.json'), record('t-loc1234'));
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'local task');
    const result = lane(repo, 'start', 'refused', '--task', 't-loc1234');
    assert.equal(result.status, 64);
    assert.match(result.stderr, /tracked .* not on origin\/main/u);
    assert.equal(existsSync(join(repo, '.krn', 'worktrees', 'refused')), false);
    assert.ok(existsSync(join(repo, 'tasks', 't-loc1234.json')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
