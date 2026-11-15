import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { atomicWrite } from '../../src/task/staged-write.ts';
import { killAtFsCall } from '../support/kill-at.ts';

const stagedModule = new URL('../../src/task/staged-write.ts', import.meta.url)
  .href;

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'receiver-faults-'));
  mkdirSync(join(root, 'tasks'));
  return root;
}

test('SIGKILL between staged write and rename leaves the old target intact', async () => {
  const root = fixture();
  try {
    const target = join(root, 'tasks', 't-1.json');
    writeFileSync(target, 'OLD');
    const { signal } = await killAtFsCall(
      'renameSync',
      `const { atomicWrite } = await import(${JSON.stringify(stagedModule)});
       atomicWrite(${JSON.stringify(root)}, ${JSON.stringify(target)}, 'NEW', true);`,
    );
    assert.equal(signal, 'SIGKILL');
    assert.equal(readFileSync(target, 'utf8'), 'OLD');
    // A later writer is not blocked by the orphaned staging file.
    atomicWrite(root, target, 'NEWER', true);
    assert.equal(readFileSync(target, 'utf8'), 'NEWER');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SIGKILL between staged write and link leaves the target absent, never partial', async () => {
  const root = fixture();
  try {
    const target = join(root, 'tasks', 't-2.json');
    await killAtFsCall(
      'linkSync',
      `const { atomicWrite } = await import(${JSON.stringify(stagedModule)});
       atomicWrite(${JSON.stringify(root)}, ${JSON.stringify(target)}, 'NEW');`,
    );
    assert.equal(existsSync(target), false);
    // Retrying the create succeeds and publishes the complete content.
    atomicWrite(root, target, 'COMPLETE');
    assert.equal(readFileSync(target, 'utf8'), 'COMPLETE');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed publish keeps the existing target and removes its staging file', () => {
  const root = fixture();
  try {
    const target = join(root, 'tasks', 't-3.json');
    writeFileSync(target, 'FIRST');
    assert.throws(
      () => atomicWrite(root, target, 'SECOND'),
      (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
    );
    assert.equal(readFileSync(target, 'utf8'), 'FIRST');
    const staging = join(root, '.krn', 'tmp', 'task-write');
    assert.deepEqual(readdirSync(staging), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
