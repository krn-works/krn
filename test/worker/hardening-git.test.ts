import assert from 'node:assert/strict';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { setup } from './hardening-fixture.ts';

test('Git HEAD, packed refs, refs trees and top-level lock changes fail scope in repositories and worktrees', {
  concurrency: 6,
}, async (t) => {
  for (const worktree of [false, true]) {
    for (const name of [
      'HEAD',
      'packed-refs',
      'refs/heads/forbidden',
      'HEAD.lock',
      'index.lock',
    ]) {
      t.test(`${worktree ? 'worktree' : 'repository'} ${name}`, async (t) => {
        const s = await setup(t, worktree);
        const gitDir = s.git(
          'rev-parse',
          '--path-format=absolute',
          name === 'HEAD' ? '--git-dir' : '--git-common-dir',
        );
        const path = join(gitDir, name);
        const result = await s.turn(`write ${relative(s.repo, path)}`, true)
          .result;
        assert.equal(result.code, 3, result.stderr);
        assert.ok(result.stderr.includes(path), result.stderr);
      });
    }
    for (const flag of ['--assume-unchanged', '--skip-worktree']) {
      t.test(`${worktree ? 'worktree' : 'repository'} ${flag}`, async (t) => {
        const s = await setup(t, worktree);
        const result = await s.turn(`index-flag ${flag}`, true).result;
        assert.equal(result.code, 3, result.stderr);
        assert.ok(result.stderr.includes('README.md'), result.stderr);
      });
    }
  }
});
