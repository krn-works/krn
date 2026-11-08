import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  pressureLines,
  probe,
  type Volume,
} from '../../scripts/claude/disk-pressure.ts';

const gib = 2 ** 30;
const volume = (path: string, device: number, freeGib: number): Volume => ({
  path,
  device,
  bsize: 4096,
  blocks: (100 * gib) / 4096,
  bavail: (freeGib * gib) / 4096,
});

test('healthy disks and the exact floor print nothing', () => {
  assert.deepEqual(
    pressureLines([volume('/home/a', 1, 50), volume('/srv', 2, 20)]),
    [],
  );
});

test('a share just under a whole percent is floored, not rounded up', () => {
  const nearly = { ...volume('/srv', 2, 19), bavail: (19 * gib) / 4096 - 1 };
  assert.match(pressureLines([nearly])[0] ?? '', /^Disk: \/srv 18% free /u);
});

test('a full disk of the same size as a healthy one still prints', () => {
  assert.deepEqual(
    pressureLines([volume('/home/a', 1, 50), volume('/srv', 2, 5.5)]),
    ['Disk: /srv 5% free (5.5 of 100.0 GiB), below the 20% floor'],
  );
});

test('two paths on one device print one line under the first path', () => {
  const home = volume('/home/a', 1, 3);
  const project = {
    ...volume('/home/a/project', 1, 3),
    bavail: home.bavail - 1,
  };
  assert.deepEqual(pressureLines([home, project]), [
    'Disk: /home/a 3% free (3.0 of 100.0 GiB), below the 20% floor',
  ]);
});

test('a pseudo filesystem without blocks prints nothing', () => {
  assert.deepEqual(
    pressureLines([{ ...volume('/proc', 3, 0), blocks: 0 }]),
    [],
  );
});

test('probe reads the real filesystem and skips a missing path', () => {
  const volumes = probe([
    tmpdir(),
    join(tmpdir(), 'missing-disk-pressure-path'),
  ]);
  assert.equal(volumes.length, 1);
  const [real] = volumes;
  assert.equal(real?.path, tmpdir());
  assert.ok((real?.blocks ?? 0) > 0, 'a real filesystem has blocks');
  assert.ok(
    (real?.bavail ?? -1) >= 0 && (real?.bavail ?? 0) <= (real?.blocks ?? 0),
  );
});
