import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderPrBody } from '../../src/cli/pr-body.ts';
import type { TaskRecord } from '../../src/task/record.ts';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

const task: TaskRecord = {
  id: 't-abc1234' as TaskRecord['id'],
  status: 'open',
  resolution: null,
  created: '2026-11-09',
  priority: 3,
  title: 'Cut text',
  after: [],
  body: [
    'Outcome: generated bodies.\nWhy: hand-written text costs money.\nProof: a test.',
  ],
};

test('pr body renders template sections from the task and commits', () => {
  const text = renderPrBody({
    task,
    commits: ['feat(cli): body (t-abc1234)'],
    verified: 'npm run fast: PASS',
    agent: 'A',
    refs: false,
  });
  assert.match(text, /## Problem\n\nhand-written text costs money\./);
  assert.match(text, /- feat\(cli\): body \(t-abc1234\)/);
  assert.match(text, /## Verification\n\nnpm run fast: PASS/);
  assert.match(text, /\nTicket: t-abc1234\n\nAgent: A\n/);
  assert.match(text, /Generated with \[Claude Code\]/);
});

test('pr body uses Refs and the planned proof when nothing was verified', () => {
  const text = renderPrBody({
    task,
    commits: [],
    verified: '',
    agent: 'A',
    refs: true,
  });
  assert.match(text, /Refs: t-abc1234/);
  assert.match(text, /Planned proof: a test\./);
  assert.match(text, /- generated bodies\./);
});

test('krn pr body reads the real task record and git log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-body-'));
  try {
    const git = (...a: string[]) =>
      spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@example.invalid');
    mkdirSync(join(dir, 'tasks'));
    writeFileSync(
      join(dir, 'tasks', 't-abc1234.json'),
      `${JSON.stringify(task, null, 2)}\n`,
    );
    git('add', '.');
    git('commit', '-qm', 'seed');
    git('commit', '-q', '--allow-empty', '-m', 'feat(x): one (t-abc1234)');
    const result = spawnSync(
      process.execPath,
      [cli, 'pr', 'body', '--task', 't-abc1234', '--base', 'HEAD~1'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /- feat\(x\): one \(t-abc1234\)/);
    assert.match(result.stdout, /Ticket: t-abc1234/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('krn pr body --worktree finds a task created only in that worktree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-body-wt-'));
  try {
    const main = join(dir, 'main');
    const lane = join(dir, 'lane');
    mkdirSync(main);
    const git = (cwd: string, ...a: string[]) =>
      spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'config', 'user.name', 't');
    git(main, 'config', 'user.email', 't@example.invalid');
    mkdirSync(join(main, 'tasks'));
    writeFileSync(
      join(main, 'tasks', 't-def5678.json'),
      `${JSON.stringify({ ...task, id: 't-def5678' }, null, 2)}\n`,
    );
    git(main, 'add', '.');
    git(main, 'commit', '-qm', 'seed');
    git(main, 'worktree', 'add', '-q', '-b', 'lane', lane);
    writeFileSync(
      join(lane, 'tasks', 't-abc1234.json'),
      `${JSON.stringify(task, null, 2)}\n`,
    );
    git(lane, 'add', '.');
    git(lane, 'commit', '-qm', 'chore(task): add (t-abc1234)');
    const run = (...extra: string[]) =>
      spawnSync(
        process.execPath,
        [cli, 'pr', 'body', '--task', 't-abc1234', '--base', 'main', ...extra],
        { cwd: main, encoding: 'utf8' },
      );
    const missing = run();
    assert.equal(missing.status, 64);
    assert.match(missing.stderr, /Unknown task t-abc1234/);
    const result = run('--worktree', lane);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /## Problem\n\nhand-written text costs money\./,
    );
    assert.match(result.stdout, /- chore\(task\): add \(t-abc1234\)/);
    assert.match(result.stdout, /## Task\n\nTicket: t-abc1234/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
