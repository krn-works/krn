import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('base ref resolution prefers --base, then origin/HEAD, then current branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'krn-base-order-'));
  try {
    git(root, ['init', '-q', '--initial-branch=master']);
    git(root, ['config', 'gc.auto', '0']);
    git(root, ['config', 'maintenance.auto', 'false']);
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

    const { resolveBaseRef } = await import('../../src/cli/index.ts');
    assert.equal(resolveBaseRef(root, 'master'), 'master');
    assert.equal(resolveBaseRef(root), 'trunk');
    git(root, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
    assert.equal(resolveBaseRef(root), 'master');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('base ref resolution uses origin/HEAD when its branch exists only remotely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'krn-base-remote-only-'));
  try {
    git(root, ['init', '-q', '--initial-branch=master']);
    git(root, ['config', 'gc.auto', '0']);
    git(root, ['config', 'maintenance.auto', 'false']);
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
    git(root, ['update-ref', 'refs/remotes/origin/trunk', 'HEAD']);
    git(root, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/trunk',
    ]);

    const { resolveBaseRef } = await import('../../src/cli/index.ts');
    const baseRef = resolveBaseRef(root);
    assert.equal(baseRef, 'origin/trunk');
    assert.equal(
      git(root, ['rev-parse', '--verify', `${baseRef}^{commit}`]),
      git(root, ['rev-parse', 'HEAD']),
    );
    assert.equal(
      spawnSync('git', [
        '-C',
        root,
        'show-ref',
        '--verify',
        '--quiet',
        'refs/heads/trunk',
      ]).status,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
