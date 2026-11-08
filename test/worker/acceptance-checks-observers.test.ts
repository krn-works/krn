import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup } from './acceptance-fixture.ts';

test('3: observers written by the turn pass or fail', async (t) => {
  for (const kind of ['pass', 'fail']) {
    const s = await setup(t);
    const r = await s.turn(`observer-${kind}`, true, [
      '--observer',
      `${kind}.test.mjs`,
    ]);
    assert.equal(r.code, kind === 'pass' ? 0 : 4, r.stderr);
    assert.equal(
      s.json('rounds/001/result.json').acceptance[0].kind,
      'observer',
    );
  }
});
test('4: missing and symlink observers fail with a reason', async (t) => {
  for (const linked of [false, true]) {
    const s = await setup(t);
    if (linked) symlinkSync('target', join(s.repo, 'missing.test.ts'));
    const r = await s.turn('done-clean', true, [
      '--observer',
      'missing.test.ts',
    ]);
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, /missing observer missing.test.ts/);
    assert.equal(
      s.json('rounds/001/result.json').acceptance[0].exit_code,
      null,
    );
  }
});
