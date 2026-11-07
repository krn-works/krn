import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { setup } from './scope-bypass-fixture.ts';

test('worker-created ignores cannot hide forbidden paths or newly created ignored trees', {
  concurrency: 6,
}, async (t) => {
  for (const path of [
    'AGENTS.md',
    'nested/CLAUDE.md',
    'node_modules/AGENTS.md',
    '.krn/other/AGENTS.md',
  ]) {
    t.test(path, async (t) => {
      const s = await setup(t);
      const result = await s.turn(`ignore ${path}`).result;
      assert.equal(result.code, 3, result.stderr);
      assert.ok(result.stderr.includes(path), result.stderr);
    });
  }
});
test('baseline ignored trees are skipped while new paths still undergo tiers on every turn', async (t) => {
  const s = await setup(t);
  // More than the per-turn limit already exists; it must never be descended.
  mkdirSync(join(s.repo, 'node_modules/dependency'), { recursive: true });
  for (let i = 0; i <= 10000; i++)
    writeFileSync(
      join(s.repo, 'node_modules/dependency', `${i}.js`),
      'existing',
    );
  mkdirSync(join(s.repo, '.krn/runs/other'), { recursive: true });
  writeFileSync(join(s.repo, '.krn/runs/other/AGENTS.md'), 'existing');
  assert.equal((await s.turn('ok').result).code, 0);
  const result = await s.turn('ignore AGENTS.md').result;
  assert.equal(result.code, 3, result.stderr);
  assert.ok(result.stderr.includes('AGENTS.md'), result.stderr);
});
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
