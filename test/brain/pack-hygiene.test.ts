import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parseUnified } from '../../src/brain/record.ts';

const pack = parseUnified(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../standards/records.json'),
      'utf8',
    ),
  ),
);

test('KRN-process records are not in the universal layer', () => {
  for (const id of [
    's-no-shared-stash',
    's-agent-state',
    's-finish-gate',
    's-ticket-trailer',
  ]) {
    const record = pack.find((r) => r.id === id);
    assert.ok(record, id);
    assert.equal(record.layer, 'krn-delivery', id);
    assert.equal(record.universal, undefined, id);
  }
});

test('every accepted advisory pack record carries a review date', () => {
  const bare = pack
    .filter(
      (r) =>
        r.status === 'accepted' &&
        r.enforcement.kind === 'advisory' &&
        r.review_by === undefined,
    )
    .map((r) => r.id);
  assert.deepEqual(bare, []);
});
