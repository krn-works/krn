import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setup, snapshot, until, worker } from './input-bounds-fixture.ts';

test('direct driver input validates its repository boundary before acquiring a lock', async (t) => {
  const s = setup(t);
  assert.equal((await s.turn('ok', true)).code, 0);
  assert.equal((await s.command(['stop'])).code, 0);
  const saved = JSON.parse(
    fs.readFileSync(join(s.run, 'closed-session.json'), 'utf8'),
  );
  const outside = join(s.root, 'outside');
  fs.mkdirSync(join(outside, 'tmp'), { recursive: true });
  fs.writeFileSync(
    join(outside, 'session.json'),
    JSON.stringify({
      ...saved,
      run: outside,
      roots: [s.repo, outside],
      rounds: 0,
      threadId: '',
      pid: 0,
      serverPid: 0,
      status: 'running',
    }),
  );
  const before = snapshot(outside);
  const child = spawn(
    process.execPath,
    [resolve('src/worker/driver.ts'), outside],
    { env: s.env, detached: true },
  );
  let stderr = '';
  let finished = false;
  child.stdout.resume();
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const result = new Promise<number | null>((done) =>
    child.once('close', (code) => {
      finished = true;
      done(code);
    }),
  );
  try {
    await until(() => finished || fs.existsSync(join(outside, 'driver.lock')));
    assert.equal(
      finished,
      true,
      'refused driver must exit before writing a lock',
    );
    assert.equal(await result, 64, stderr);
    assert.deepEqual(snapshot(outside), before);
  } finally {
    for (const pid of [
      child.pid,
      JSON.parse(fs.readFileSync(join(outside, 'session.json'), 'utf8'))
        .serverPid,
    ]) {
      if (!pid) continue;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    }
    await result;
  }
});

test('file reads bound the opened descriptor even when the pathname is replaced', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'krn-worker-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'input');
  fs.writeFileSync(path, 'x'.repeat(1025));
  const original = fs.openSync;
  const mutable = { ...fs };
  mutable.openSync = (...args) => {
    const fd = original(...args);
    if (args[0] === path) {
      fs.renameSync(path, join(root, 'opened'));
      fs.writeFileSync(path, 'small');
    }
    return fd;
  };
  // Patch the builtin through its mutable default export, then restore it.
  Object.assign(fs, { openSync: mutable.openSync });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => worker().readText(path, 1024),
      (error) => error instanceof worker().WorkerError && error.exitCode === 65,
    );
  } finally {
    Object.assign(fs, { openSync: original });
    syncBuiltinESMExports();
  }
});

test('atomic records are bounded before creating their parent directory', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'krn-worker-record-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () =>
      worker().atomic(join(root, 'new/record'), {
        text: 'x'.repeat(2 * 1024 * 1024),
      }),
    (error) => error instanceof worker().WorkerError && error.exitCode === 65,
  );
  assert.equal(fs.existsSync(join(root, 'new')), false);
});

test('failed atomic publication removes its own temporary file', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'krn-worker-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'record');
  fs.mkdirSync(path);
  assert.throws(() => worker().atomic(path, { text: 'bounded' }));
  assert.deepEqual(fs.readdirSync(root), ['record']);
});
