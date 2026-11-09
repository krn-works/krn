import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup } from './input-bounds-fixture.ts';

// One owner per baseline bound: the file count is counted under .krn and the
// byte total accumulates across roots, so neither a per-file size check nor an
// uncounted .krn passes.
test('untracked baseline enforces file-count and accumulated content bounds before launching a server', {
  concurrency: 6,
}, async (t) => {
  for (const bound of ['files', 'bytes']) {
    t.test(bound, async (t) => {
      const s = setup(t);
      if (bound === 'files') {
        const outsideRun = join(s.repo, '.krn/other');
        fs.mkdirSync(outsideRun, { recursive: true });
        for (let i = 0; i <= 10000; i++)
          fs.writeFileSync(join(outsideRun, String(i)), 'x');
      } else {
        // Git lists untracked roots sorted, so the 1-byte root is summed
        // first and the exactly-1 GB root crosses the total without being read.
        fs.writeFileSync(join(s.repo, 'a-small'), 'x');
        const large = join(s.repo, 'b-large');
        fs.writeFileSync(large, '');
        fs.truncateSync(large, 1024 * 1024 * 1024);
      }
      const result = await s.turn('ok', true);
      assert.equal(result.code, 65, result.stderr);
      assert.match(result.stderr, bound === 'files' ? /10000/ : /1 GB/);
      assert.equal(fs.existsSync(s.env.CODEX_TEST_WORKER_PID ?? ''), false);
    });
  }
});

test('exactly 10000 .krn files fit the file bound, with the own run excluded', async (t) => {
  const s = setup(t);
  const path = join(s.repo, '.krn/other');
  fs.mkdirSync(path, { recursive: true });
  for (let i = 0; i < 10000; i++) fs.writeFileSync(join(path, String(i)), '');
  const result = await s.turn('ok', true);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await s.turn('write .krn/other/0')).code, 3);
});
