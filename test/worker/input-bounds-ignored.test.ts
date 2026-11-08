import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setup } from './input-bounds-fixture.ts';

test('ignored .krn baseline detects changed, created, deleted and retyped paths outside its run', {
  concurrency: 6,
}, async (t) => {
  for (const action of ['write', 'delete', 'retype', 'relink']) {
    t.test(action, async (t) => {
      const s = setup(t);
      const path = '.krn/runs/other/record';
      fs.mkdirSync(dirname(join(s.repo, path)), { recursive: true });
      if (action === 'relink') fs.symlinkSync('before', join(s.repo, path));
      else fs.writeFileSync(join(s.repo, path), 'before edit');
      const result = await s.turn(`${action} ${path}`, true);
      assert.equal(result.code, 3, result.stderr);
      assert.ok(result.stderr.includes(path), result.stderr);
    });
  }
  t.test('new path after an unchanged turn', async (t) => {
    const s = setup(t);
    fs.mkdirSync(join(s.repo, '.krn/runs/other'), { recursive: true });
    assert.equal((await s.turn('ok', true)).code, 0);
    const result = await s.turn('write .krn/runs/other/new');
    assert.equal(result.code, 3, result.stderr);
  });
});

test('ignored forbidden roots also remain in the baseline', async (t) => {
  const s = setup(t);
  fs.mkdirSync(join(s.repo, '.codex'));
  fs.writeFileSync(join(s.repo, '.codex/config.toml'), 'before edit');
  const result = await s.turn('write .codex/config.toml', true);
  assert.equal(result.code, 3, result.stderr);
});

test('ignored ordinary roots cannot hide baseline instruction files or new symlinks', {
  concurrency: 6,
}, async (t) => {
  for (const action of ['write private/AGENTS.md', 'link private/new-link']) {
    t.test(action, async (t) => {
      const s = setup(t);
      fs.mkdirSync(join(s.repo, 'private'));
      fs.writeFileSync(join(s.repo, 'private/AGENTS.md'), 'before edit');
      const result = await s.turn(action, true);
      assert.equal(result.code, 3, result.stderr);
    });
  }
});
