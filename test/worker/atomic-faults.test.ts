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
import { atomic } from '../../src/worker/state.ts';
import { killAtFsCall } from '../support/kill-at.ts';

const stateModule = new URL('../../src/worker/state.ts', import.meta.url).href;

test('SIGKILL between temp write and rename leaves the old record, then a rewrite succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-atomic-'));
  try {
    const path = join(dir, 'inbox', '001.json');
    atomic(path, { v: 'old' });
    const { pid } = await killAtFsCall(
      'renameSync',
      `const { atomic } = await import(${JSON.stringify(stateModule)});
       atomic(${JSON.stringify(path)}, { v: 'new' });`,
    );
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { v: 'old' });
    assert.ok(readdirSync(join(dir, 'inbox')).includes(`001.json.${pid}.tmp`));
    atomic(path, { v: 'newer' });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { v: 'newer' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGKILL before the first publish leaves no record at all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-atomic-'));
  try {
    const path = join(dir, 'inbox', '002.json');
    await killAtFsCall(
      'renameSync',
      `const { atomic } = await import(${JSON.stringify(stateModule)});
       atomic(${JSON.stringify(path)}, { v: 'new' });`,
    );
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rename failure removes its temp file and keeps the blocking target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-atomic-'));
  try {
    const path = join(dir, 'x.json');
    mkdirSync(join(path, 'child'), { recursive: true });
    assert.throws(() => atomic(path, { v: 'new' }));
    assert.ok(existsSync(join(path, 'child')));
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale temp file left by a killed process with a reused PID does not block writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-atomic-'));
  try {
    const path = join(dir, 'x.json');
    writeFileSync(`${path}.${process.pid}.tmp`, 'torn');
    atomic(path, { v: 'ok' });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { v: 'ok' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
