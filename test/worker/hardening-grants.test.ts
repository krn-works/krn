import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup } from './hardening-fixture.ts';

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
