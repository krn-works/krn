import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decide } from '../../src/hook/unpushed-delete.ts';

test('a Git directory given as PWD still protects the open task', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'review-git-pwd-'));
  try {
    const git = (...args: string[]) => {
      const result = spawnSync(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'core.hooksPath=/dev/null',
          ...args,
        ],
        { cwd, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr ?? '');
    };
    git('init', '-q', '-b', 'main');
    mkdirSync(join(cwd, 'tasks'));
    writeFileSync(join(cwd, 'tasks/t-ab12.json'), '{"status":"open"}');
    git('add', 'tasks');
    git('commit', '-qm', 'Base');
    git('switch', '-qc', 'lane');
    git('commit', '--allow-empty', '-qm', 'Work', '-m', 'Ticket: t-ab12');
    git('switch', '-q', 'main');
    const check = (command: string) => decide({ cwd, tool_input: { command } });
    assert.match(check('git branch -D lane') ?? '', /open task t-ab12/u);
    assert.match(
      check('git -C "$PWD" branch -D lane') ?? '',
      /open task t-ab12/u,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function fixture(path: string, status: string) {
  mkdirSync(path, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync(
      'git',
      [
        '-C',
        path,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr ?? '');
  };
  git('init', '-q', '-b', 'main');
  mkdirSync(join(path, 'tasks'));
  writeFileSync(join(path, 'tasks/t-ab12.json'), JSON.stringify({ status }));
  git('add', 'tasks');
  git('commit', '-qm', 'Base');
  git('switch', '-qc', 'lane');
  git('commit', '--allow-empty', '-qm', 'Work', '-m', 'Ticket: t-ab12');
  git('switch', '-q', 'main');
}

test('a path with shell syntax the reader cannot resolve falls back to the current checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'unresolved-path-'));
  try {
    const cwd = join(root, 'repo-$&');
    fixture(cwd, 'open');
    const check = (command: string) => decide({ cwd, tool_input: { command } });
    assert.match(
      check('git -C "$PWD" branch -D lane') ?? '',
      /open task t-ab12/u,
    );
    assert.match(
      check('git -C $PWD branch -D lane') ?? '',
      /open task t-ab12/u,
    );
    assert.match(
      check('git -C "$OTHER/x" branch -D lane') ?? '',
      /open task t-ab12/u,
    );
    assert.match(
      check('git -C "$OTHER/x" branch -D nothere') ?? '',
      /Refused/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('single quotes keep a literal dollar path as the repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'literal-path-'));
  try {
    fixture(join(root, 'repo'), 'open');
    fixture(join(root, '$PWD', 'repo'), 'closed');
    const check = (command: string) =>
      decide({ cwd: root, tool_input: { command } });
    assert.equal(check("git -C '$PWD/repo' branch -D lane"), undefined);
    assert.match(
      check("git -C './repo' branch -D lane") ?? '',
      /open task t-ab12/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
