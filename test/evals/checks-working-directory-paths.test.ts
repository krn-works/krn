import assert from 'node:assert/strict';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, refusal } from './checks-fixture.ts';

test('eval check rejects symlinked and missing working directories and preserves experiment bytes', async () => {
  const f = await fixture();
  try {
    const before = await readFile(join(f.experiment, 'manifest.json'));
    const parent = join(f.repo, 'link');
    await symlink(f.cwd, parent);
    f.task.workingDirectory = 'link';
    await f.save();
    refusal(f.run(), 65, /symlink/u);
    f.task.workingDirectory = 'link/child';
    await f.save();
    refusal(f.run(), 65, /symlink/u);
    for (const directory of ['absent', 'package/behavior.test.cjs']) {
      f.task.workingDirectory = directory;
      await f.save();
      refusal(f.run(), 65, /directory/u);
    }
    await writeFile(join(f.experiment, 'manifest.json'), before);
    assert.deepEqual(
      await readFile(join(f.experiment, 'manifest.json')),
      before,
    );
  } finally {
    await f.cleanup();
  }
});
