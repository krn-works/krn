import assert from 'node:assert/strict';
import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { failure, fixture } from './workspace-fixture.ts';

test('eval prepare validates source labels, base objects and the frozen input contract', async (t) => {
  for (const kind of [
    'missing',
    'duplicate',
    'unknown',
    'missing base',
    'draft',
    'hash',
  ]) {
    await t.test(kind, async () => {
      const f = await fixture();
      try {
        if (kind === 'missing')
          failure(f.prepare({ sources: [] }), 64, /source/u);
        else if (kind === 'duplicate')
          failure(
            f.prepare({
              sources: [`fixture=${f.source}`, `fixture=${f.source}`],
            }),
            64,
            /duplicate|once/u,
          );
        else if (kind === 'unknown')
          failure(
            f.prepare({
              sources: [`fixture=${f.source}`, `unknown=${f.source}`],
            }),
            64,
            /unknown/u,
          );
        else if (kind === 'missing base') {
          for (const task of f.value.tasks) task.baseSha = 'a'.repeat(40);
          await f.save();
          failure(f.prepare(), 65, /base/u);
        } else if (kind === 'draft') {
          f.value.frozen = false;
          await f.save();
          failure(f.prepare(), 65, /frozen.*--draft/u);
          const result = f.prepare({ extra: ['--draft'] });
          assert.equal(result.status, 0, result.stderr);
        } else {
          await writeFile(join(f.experiment, 'packet.md'), 'changed');
          failure(f.prepare(), 65, /sha256/u);
        }
      } finally {
        await f.cleanup();
      }
    });
  }
});
test('eval prepare rejects repository labels outside the identifier rule', async () => {
  const f = await fixture();
  try {
    const task = f.value.tasks[0];
    assert.ok(task);
    task.repository = 'team=repo';
    await f.save();
    failure(f.prepare(), 65, /repository|identifier|regex/u);
  } finally {
    await f.cleanup();
  }
});
test('eval prepare splits source paths at the first equals sign', async () => {
  const f = await fixture();
  try {
    const alias = join(f.directory, 'source=mirror');
    await symlink(f.source, alias);
    const result = f.prepare({ sources: [`fixture=${alias}`] });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await f.cleanup();
  }
});
test('eval prepare names the failed invariant when the exemplar is reachable from base', async () => {
  const f = await fixture();
  try {
    for (const task of f.value.tasks) task.exemplarSha = f.base;
    await f.save();
    failure(f.prepare(), 65, /invariant failed: exemplar object is absent/u);
  } finally {
    await f.cleanup();
  }
});
