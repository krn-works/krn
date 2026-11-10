import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { renderRetro } from '../../src/state/retro.ts';
import { buildCaseRepo } from './fixture-repo.ts';

// The retro prints the window of the task's span, read on the main checkout
// even when the retro runs in a linked worktree (a worktree refuses the window).
function git(root: string, ...args: string[]) {
  const result = spawnSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.invalid',
      ...args,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
}

test('retro prints the window block for the task span, measured from the main checkout', async () => {
  const root = realpathSync(buildCaseRepo('active'));
  git(root, 'commit', '-q', '--allow-empty', '-m', 'feat: a (t-abc1234) (#12)');
  const linked = join(root, '..', `${root.split('/').pop()}-linked`);
  git(root, 'worktree', 'add', '-q', '-b', 'lane', linked);
  const calls: [string, string, string][] = [];
  const text = await renderRetro(
    realpathSync(linked),
    't-abc1234',
    async (from, to, main) => {
      calls.push([from, to, main]);
      return 'WINDOW BODY\n';
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[2], root, 'window root is the main checkout');
  assert.match(
    text,
    /Window \S+\.\.\S+ \(krn ledger, main checkout\):\nWINDOW BODY\n/,
  );
  const failed = await renderRetro(root, 't-abc1234', async () => {
    throw new Error('gh missing');
  });
  assert.match(failed, /Window \S+\.\.\S+: unavailable \(gh missing\)/);
  const none = await renderRetro(root, 't-zzz9999', async () => 'x');
  assert.doesNotMatch(none, /Window/);
});
