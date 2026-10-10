import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveBaseRef } from '../../src/cli/index.ts';

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('base ref resolution prefers --base, then origin/HEAD, then current branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'krn-base-order-'));
  try {
    git(root, ['init', '-q', '--initial-branch=master']);
    await writeFile(join(root, '.gitignore'), '.krn/\n');
    await writeFile(join(root, 'README.md'), 'initial commit\n');
    git(root, ['add', '.gitignore', 'README.md']);
    git(root, [
      '-c',
      'user.name=Base Ref Test',
      '-c',
      'user.email=base-ref@example.invalid',
      'commit',
      '-qm',
      'initial commit',
    ]);
    git(root, ['branch', 'trunk']);
    git(root, ['update-ref', 'refs/remotes/origin/trunk', 'trunk']);
    git(root, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/trunk',
    ]);

    assert.equal(resolveBaseRef(root, 'master'), 'master');
    assert.equal(resolveBaseRef(root), 'trunk');
    git(root, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
    assert.equal(resolveBaseRef(root), 'master');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
