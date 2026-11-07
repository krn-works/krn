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
import {
  appendComment,
  parseComments,
  readComments,
} from '../../src/task/comments.ts';
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

test('a torn trailing comment line keeps earlier comments, blocks nothing, and is dropped by the next append', () => {
  const root = fixture();
  try {
    const id = 't-4' as Parameters<typeof appendComment>[1];
    const first = appendComment(root, id, {
      actor: 'a',
      text: 'one',
      at: '2026-11-07T00:00:00.000Z',
    });
    const path = join(root, 'tasks', 't-4.comments.jsonl');
    writeFileSync(
      path,
      `${readFileSync(path, 'utf8')}{"actor":"b","at":"2026-11-07T00:00:01.0`,
    );
    assert.deepEqual(readComments(root, id), [first]);
    // An unacknowledged torn tail must not stop every krn task command.
    assert.deepEqual(parseComments(readFileSync(path)).findings, []);
    const next = appendComment(root, id, {
      actor: 'c',
      text: 'three',
      at: '2026-11-07T00:00:02.000Z',
    });
    assert.deepEqual(readComments(root, id), [first, next]);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /00:00:01/u);
    assert.deepEqual(parseComments(readFileSync(path)).findings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a SIGKILL during comment append leaves only whole lines or a detectable tail', async () => {
  const root = fixture();
  try {
    const id = 't-5' as Parameters<typeof appendComment>[1];
    const first = appendComment(root, id, {
      actor: 'a',
      text: 'one',
      at: '2026-11-07T00:00:00.000Z',
    });
    await killAtFsCall(
      'appendFileSync',
      `const { appendComment } = await import(${JSON.stringify(
        new URL('../../src/task/comments.ts', import.meta.url).href,
      )});
       appendComment(${JSON.stringify(root)}, 't-5', { actor: 'b', text: 'two' });`,
    );
    assert.deepEqual(readComments(root, id), [first]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
