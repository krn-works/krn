import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('krn pr ship --detach with a relative --worktree starts a child that finds the worktree', () => {
  const repo = mkdtempSync(join(tmpdir(), 'ship-live-repo-'));
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git(
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'i',
  );
  git('worktree', 'add', '-q', '.krn/worktrees/w', '-b', 'w');
  // The body sits beside the caller, not in the worktree: the child must still read it.
  writeFileSync(
    join(repo, 'b'),
    '## Why\n\nx\n\n## Verified\n\ny\n\nRefs: t-abcdefg\n',
  );
  const entry = fileURLToPath(
    new URL('../../src/cli/krn.mjs', import.meta.url),
  );
  const started = spawnSync(
    process.execPath,
    [
      entry,
      'pr',
      'ship',
      '--detach',
      '--worktree',
      '.krn/worktrees/w',
      '--title',
      'fix(x): y (t-abcdefg)',
      '--body-file',
      'b',
    ],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.equal(started.status, 0, started.stderr);
  const log = join(repo, '.krn', 'worktrees', 'w', '.krn', 'tmp', 'ship.log');
  let text = '';
  for (let attempt = 0; attempt < 100 && text === ''; attempt++) {
    text = existsSync(log) ? readFileSync(log, 'utf8') : '';
    if (text === '') spawnSync('sleep', ['0.2']);
  }
  assert.doesNotMatch(text, /ENOENT/);
});
