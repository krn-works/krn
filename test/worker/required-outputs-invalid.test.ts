import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { setup } from './required-outputs-fixture.ts';

test('invalid required paths never start a turn', async (t) => {
  for (const paths of [
    ['../x'],
    ['/abs'],
    ['*'],
    ['a/'],
    ['a/../b'],
    ['a', 'a'],
    ['x'.repeat(4097)],
    Array.from({ length: 65 }, (_, i) => `a${i}`),
  ]) {
    const s = await setup(t);
    const r = await s.turn(
      'ok',
      true,
      paths.flatMap((p) => ['--require', p]),
    );
    assert.equal(r.code, 64, r.stderr);
    assert.equal(existsSync(s.env.CODEX_TEST_WORKER_LOG ?? ''), false);
  }
});
test('scope violation wins over required output including symlinks', async (t) => {
  for (const action of ['write AGENTS.md', 'link a.txt']) {
    const s = await setup(t);
    const r = await s.turn(action, true, ['--require', 'a.txt']);
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, /scope violation/);
  }
});
