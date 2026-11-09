import assert from 'node:assert/strict';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { setup } from './scope-bypass-fixture.ts';

test('Git config, hooks and info changes are forbidden in repositories and linked worktrees', {
  concurrency: 6,
}, async (t) => {
  for (const worktree of [false, true]) {
    for (const name of ['config', 'hooks/post-checkout', 'info/attributes']) {
      t.test(`${worktree ? 'worktree' : 'repository'} ${name}`, async (t) => {
        const s = await setup(t, worktree);
        const path = join(s.commonDir, name);
        const result = await s.turn(`write ${relative(s.repo, path)}`).result;
        assert.equal(result.code, 3, result.stderr);
        assert.ok(result.stderr.includes(path), result.stderr);
      });
    }
  }
  t.test('worktree-local config', async (t) => {
    const s = await setup(t, true);
    const path = join(s.gitDir, 'config.worktree');
    const result = await s.turn(`write ${relative(s.repo, path)}`).result;
    assert.equal(result.code, 3, result.stderr);
    assert.ok(result.stderr.includes(path), result.stderr);
  });
});
