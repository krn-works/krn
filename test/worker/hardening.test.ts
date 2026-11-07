import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { setup } from './hardening-fixture.ts';

test('run directory is strictly below the real repository .krn with no symlink components', {
  concurrency: 6,
}, async (t) => {
  for (const location of [
    'external/.krn/run',
    'main/.krn-other/run',
    'main/.krn',
  ]) {
    t.test(location, async (t) => {
      const s = await setup(t);
      const result = await s.turn('ok', true, join(s.root, location)).result;
      assert.equal(result.code, 64, result.stderr);
      assert.equal(existsSync(s.env.CODEX_TEST_WORKER_PID), false);
    });
  }
  for (const component of ['.krn', '.krn/runs', '.krn/runs/worker']) {
    t.test(`symlink ${component}`, async (t) => {
      const s = await setup(t);
      const target = join(s.root, 'target');
      mkdirSync(target);
      const path = join(s.repo, component);
      mkdirSync(resolve(path, '..'), { recursive: true });
      symlinkSync(target, path);
      const result = await s.turn('ok', true).result;
      assert.equal(result.code, 65, result.stderr);
      assert.equal(existsSync(s.env.CODEX_TEST_WORKER_PID), false);
      rmSync(path);
    });
  }
});
test('thread and turn grant only repository and tmp roots, and tell the worker the lead commits', {
  concurrency: 6,
}, async (t) => {
  for (const worktree of [false, true]) {
    t.test(worktree ? 'linked worktree' : 'repository', async (t) => {
      const s = await setup(t, worktree);
      assert.equal((await s.turn('ok', true).result).code, 0);
      const requests = s.requests();
      const thread = requests.find((row) => row.method === 'thread/start');
      const turn = requests.find((row) => row.method === 'turn/start');
      assert.ok(thread?.params);
      assert.ok(turn?.params);
      assert.deepEqual(
        thread.params.config?.sandbox_workspace_write.writable_roots,
        [s.repo, join(s.run, 'tmp')],
      );
      assert.deepEqual(turn.params.sandboxPolicy?.writableRoots, [
        s.repo,
        join(s.run, 'tmp'),
      ]);
      assert.match(thread.params.developerInstructions ?? '', /never commit/i);
      assert.match(thread.params.developerInstructions ?? '', /lead commits/i);
    });
  }
});
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
