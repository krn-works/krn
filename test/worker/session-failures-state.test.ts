import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup } from './session-fixture.ts';

test('unknown app-server version is refused', async (t) => {
  const s = await setup(t);
  s.env.CODEX_TEST_WORKER_VERSION = '9.0.0';
  assert.equal((await s.turn('ok', true)).code, 65);
});
test('run and inbox symlinks, corrupt metrics and stale state fail closed', async (t) => {
  const s = await setup(t);
  mkdirSync(join(s.repo, '.krn/runs'), { recursive: true });
  symlinkSync(s.root, s.run);
  assert.equal((await s.turn('ok', true)).code, 65);
  rmSync(s.run);
  assert.equal((await s.turn('ok', true)).code, 0);
  const inbox = join(s.run, 'inbox');
  rmSync(inbox, { recursive: true });
  symlinkSync(s.root, inbox);
  assert.equal((await s.turn('ok')).code, 65);
  rmSync(inbox);
  mkdirSync(inbox);
  const state = readFileSync(join(s.run, 'session.json'));
  writeFileSync(join(s.run, 'session.json'), '{');
  assert.equal((await s.turn('ok')).code, 65);
  writeFileSync(join(s.run, 'session.json'), state);
  writeFileSync(join(s.run, 'client.lock'), '');
  assert.equal((await s.turn('ok')).code, 75);
  rmSync(join(s.run, 'client.lock'));
  writeFileSync(join(s.run, 'rounds/001/metrics.json'), '{');
  assert.equal((await s.turn('ok')).code, 65);
  assert.equal((await s.command('stop')).code, 0);
  const stale = {
    ...s.json('closed-session.json'),
    pid: 2147483647,
    status: 'running',
  };
  writeFileSync(join(s.run, 'session.json'), JSON.stringify(stale));
  assert.equal((await s.turn('ok', true)).code, 75);
  assert.equal((await s.command('stop')).code, 0);
});
test('stop interrupts an active turn while the client is waiting', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('ok', true)).code, 0);
  const pending = s.turn('hang');
  const deadline = Date.now() + 10000;
  while (s.requests().filter((x) => x.method === 'turn/start').length < 2) {
    assert.ok(Date.now() < deadline, 'turn did not start');
    await new Promise(setImmediate);
  }
  assert.equal((await s.command('stop')).code, 0);
  assert.equal((await pending).code, 75);
});
