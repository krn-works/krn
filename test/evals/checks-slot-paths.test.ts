import assert from 'node:assert/strict';
import { readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, refusal } from './checks-fixture.ts';

test('eval check rejects unsafe slot paths and preserves experiment bytes', async () => {
  const f = await fixture();
  try {
    const before = await readFile(join(f.experiment, 'manifest.json'));
    const alias = join(f.directory, 'alias');
    await symlink(f.slot, alias);
    for (const path of [
      'relative',
      f.experiment,
      f.directory,
      alias,
      `${alias}/../slot`,
      join(f.directory, 'absent'),
      join(f.cwd, 'package.json'),
      '/',
      join(f.directory, 'x'.repeat(5000)),
    ]) {
      const args = f.args();
      args[args.indexOf(f.slot)] = path;
      refusal(f.invoke(args), 65, /slot|path|directory|overlap/u);
    }
    assert.deepEqual(
      await readFile(join(f.experiment, 'manifest.json')),
      before,
    );
  } finally {
    await f.cleanup();
  }
});
