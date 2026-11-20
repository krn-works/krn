import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { withSlot } from '../../src/repo/slot-lock.ts';

test('a write-only PID file does not prevent its owner from releasing the slot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-slot-'));
  try {
    assert.equal(
      await withSlot({ dir }, async () => {
        chmodSync(join(dir, 'slot-0', 'pid'), 0o200);
        return 42;
      }),
      42,
    );
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releasing removes the slot directory after its PID file disappeared', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-slot-'));
  try {
    await withSlot({ dir }, async () => unlinkSync(join(dir, 'slot-0', 'pid')));
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
