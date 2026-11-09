import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
