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

test('a ship recorded in the pid file is live although its command line never says ship', async () => {
  const { spawn } = await import('node:child_process');
  const { mkdirSync } = await import('node:fs');
  const { liveShipPid, markShipLive } = await import(
    '../../src/ci/ship-live.ts'
  );
  const worktree = mkdtempSync(join(tmpdir(), 'ship-live-rec-'));
  mkdirSync(join(worktree, '.git'));
  // A process whose command line has no "ship", as a ship run inside `krn lane run` has none.
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    assert.ok(child.pid !== undefined);
    markShipLive(worktree, child.pid);
    assert.equal(liveShipPid(worktree), child.pid);
  } finally {
    child.kill('SIGKILL');
  }
});

test('a pid file whose pid was recycled by another process is not live', async () => {
  const { mkdirSync } = await import('node:fs');
  const { liveShipPid, shipPidPath } = await import(
    '../../src/ci/ship-live.ts'
  );
  const worktree = mkdtempSync(join(tmpdir(), 'ship-live-old-'));
  mkdirSync(join(worktree, '.krn', 'tmp'), { recursive: true });
  // This process runs, but it started long after the recorded start time.
  writeFileSync(join(worktree, shipPidPath), `${process.pid} 1\n`);
  assert.equal(liveShipPid(worktree), undefined);
});
