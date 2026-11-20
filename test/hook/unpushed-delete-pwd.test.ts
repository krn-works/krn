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
