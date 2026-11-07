import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { shipFixture } from './ship.test.ts';

for (const status of ['200', '405', '409'])
  test(`merge API ${status} capture, single PUT`, async (t) => {
    const f = shipFixture(t);
    f.config.response = status;
    const result = await f.invoke();
    assert.equal(result.ok, status === '200', JSON.stringify(result));
    assert.equal(f.puts(), 1);
    const record = JSON.parse(fs.readFileSync(f.record, 'utf8'));
    assert.equal(record.status, status === '200' ? 'published' : 'pending');
    if (status === '200') {
      assert.equal(record.treeMatch, true);
      assert.deepEqual(record.publishedParents, [record.base, record.head]);
    }
  });
test('transport failure reads back merged PR without retry', async (t) => {
  const f = shipFixture(t);
  f.config.transport = true;
  assert.equal((await f.invoke()).ok, true);
  assert.equal(f.puts(), 1);
});
for (const property of ['parents', 'tree', 'contained'] as const)
  test(`published ${property} mismatch never writes final record`, async (t) => {
    const f = shipFixture(t);
    if (property === 'contained') f.config.contained = false;
    else f.config[property] = 'f'.repeat(40);
    const result = await f.invoke();
    assert.equal(result.ok, false);
    assert.equal(f.puts(), 1);
    assert.equal(
      JSON.parse(fs.readFileSync(f.record, 'utf8')).status,
      'pending',
    );
  });
