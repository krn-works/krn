import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
