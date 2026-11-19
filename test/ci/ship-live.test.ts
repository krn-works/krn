import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { detachedShipArgs } from '../../src/ci/ship-live.ts';

const root = mkdtempSync(join(tmpdir(), 'ship-live-'));
const abs = join(root, '.krn', 'worktrees', 'w');
mkdirSync(abs, { recursive: true });

test('a relative --worktree becomes absolute, since the detached child starts inside the worktree', () => {
  const got = detachedShipArgs(
    ['--title', 't', '--worktree', '.krn/worktrees/w'],
    root,
  );
  assert.equal(got.worktree, abs);
  assert.deepEqual(got.args, ['--title', 't', '--worktree', abs]);
});

test('the --worktree=<path> form and the caller directory default resolve too', () => {
  assert.deepEqual(detachedShipArgs(['--worktree=.krn/worktrees/w'], root), {
    worktree: abs,
    args: [`--worktree=${abs}`],
  });
  assert.equal(detachedShipArgs(['--title', 't'], root).worktree, root);
});

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
