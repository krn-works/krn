import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { withFileLock } from '../../src/cli/lane-lock.ts';

const lockModule = fileURLToPath(
  new URL('../../src/cli/lane-lock.ts', import.meta.url),
);

/** A separate process that appends start and end around a 400 ms hold of the lock. */
function holder(
  lock: string,
  log: string,
  name: string,
): Promise<number | null> {
  const script = `const { withFileLock, sleepSync } = await import(process.env.LOCK_MODULE); const { appendFileSync } = await import('node:fs'); withFileLock(process.env.LOCK, () => { appendFileSync(process.env.LOG, process.env.NAME + ' start\\n'); sleepSync(400); appendFileSync(process.env.LOG, process.env.NAME + ' end\\n'); }, 20);`;
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        env: {
          ...process.env,
          LOCK_MODULE: lockModule,
          LOCK: lock,
          LOG: log,
          NAME: name,
        },
        stdio: 'inherit',
      },
    );
    child.on('close', resolve);
  });
}

test('concurrent holders of the lane lock run one at a time', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'krn-lane-lock-')));
  try {
    const lock = join(dir, '.krn', 'tmp', 'lane-baseline.lock');
    const log = join(dir, 'log');
    writeFileSync(log, '');
    const codes = await Promise.all(
      ['a', 'b', 'c'].map((name) => holder(lock, log, name)),
    );
    assert.deepEqual(codes, [0, 0, 0]);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(lines.length, 6);
    for (let index = 0; index < lines.length; index += 2) {
      const name = lines[index]?.split(' ')[0];
      assert.deepEqual(
        [lines[index], lines[index + 1]],
        [`${name} start`, `${name} end`],
      );
    }
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock left by a dead process is taken over', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'krn-lane-lock-')));
  try {
    const lock = join(dir, 'lane-baseline.lock');
    const dead = spawnSync('true').pid;
    writeFileSync(lock, String(dead));
    assert.equal(
      withFileLock(lock, () => 'ran', 20),
      'ran',
    );
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
