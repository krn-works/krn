import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '../..');
const krn = join(root, 'bin/krn');

for (const text of [
  'what must a regression test for a defect fix look like and where does it go',
  'regression test defect fix lowest layer',
]) {
  test(`a query with no flags lists r-regression-layer: ${text}`, () => {
    const out = spawnSync(krn, ['standards', 'query', text, '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(out.status, 0, out.stderr);
    const ids = (JSON.parse(out.stdout) as { id: string }[]).map(
      (hit) => hit.id,
    );
    assert.ok(ids.includes('r-regression-layer'), ids.join(', '));
  });
}
