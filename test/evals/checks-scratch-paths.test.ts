import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, refusal } from './checks-fixture.ts';

test('eval check rejects overlapping or symlinked scratch areas and preserves experiment bytes', async () => {
  const f = await fixture();
  try {
    const before = await readFile(join(f.experiment, 'manifest.json'));
    const nestedSlot = join(f.experiment, 'slot');
    await mkdir(join(nestedSlot, 'repo'), { recursive: true });
    const nestedArgs = f.args();
    nestedArgs[nestedArgs.indexOf(f.slot)] = nestedSlot;
    refusal(f.invoke(nestedArgs), 65, /overlap/u);
    assert.deepEqual(await readdir(nestedSlot), ['repo']);
    const args = f.args();
    refusal(f.invoke(args, { ...f.env, TMPDIR: f.slot }), 65, /overlap/u);
    refusal(f.invoke(args, { ...f.env, TMPDIR: f.directory }), 65, /overlap/u);
    refusal(f.invoke(args, { ...f.env, TMPDIR: f.experiment }), 65, /overlap/u);
    refusal(
      f.invoke(args, { ...f.env, TMPDIR: join(f.slot, 'scratch') }),
      65,
      /overlap/u,
    );
    refusal(f.invoke(args, { ...f.env, TMPDIR: '/tmp' }), 65, /overlap/u);
    const linkedScratch = join(f.directory, 'scratch-link');
    await symlink(f.evaluator, linkedScratch);
    refusal(
      f.invoke(args, { ...f.env, TMPDIR: linkedScratch }),
      65,
      /symlink/u,
    );
    for (const name of ['home', 't']) {
      await symlink(f.evaluator, join(f.slot, name));
      refusal(f.run(), 65, /symlink/u);
      await rm(join(f.slot, name));
    }
    assert.deepEqual(
      await readFile(join(f.experiment, 'manifest.json')),
      before,
    );
  } finally {
    await f.cleanup();
  }
});
