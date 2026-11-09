import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { alive, setup, signalPending, until } from './recovery-fixture.ts';

test('stop recovers a missing server before the driver records dead and stops its remaining scope members', {
  concurrency: 6,
}, async (t) => {
  for (const driver of ['live', 'dead']) {
    t.test(driver, async (t) => {
      const s = await setup(t);
      const pending = s.turn('hang-child', true);
      await until(() => pending.finished || existsSync(s.orphan));
      assert.equal(
        pending.finished,
        false,
        'start ended before the test server created its child',
      );
      const saved = await s.freeze();
      assert.equal(saved.status, 'running');
      const child = Number(readFileSync(s.orphan, 'utf8'));
      s.owned.add(child);
      process.kill(saved.serverPid, 'SIGKILL');
      await until(() => !alive(saved.serverPid));
      assert.equal(alive(child), true);
      if (driver === 'dead') {
        process.kill(saved.pid, 'SIGKILL');
        await until(() => !alive(saved.pid));
      }
      const stop = s.launch('stop');
      if (driver === 'live') {
        await until(() => stop.finished || signalPending(saved.pid));
        process.kill(saved.pid, 'SIGCONT');
      }
      const result = await stop.result;
      assert.equal(result.code, 0, result.stderr);
      assert.equal((await pending.result).code, 75);
      assert.equal(alive(saved.pid), false);
      assert.equal(alive(child), false, 'recorded scope child survived stop');
      assert.ok(
        s
          .rows()
          .some(
            (row) =>
              JSON.stringify(row) ===
              JSON.stringify(['--user', 'stop', s.unit()]),
          ),
      );
      assert.equal(existsSync(join(s.run, 'session.json')), false);
      assert.equal(existsSync(join(s.run, 'closed-session.json')), true);
    });
  }
});

test('stale start reaps a deterministic scope even when both recorded processes are gone', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('ok', true).result).code, 0);
  const saved = await s.freeze();
  process.kill(saved.pid, 'SIGKILL');
  process.kill(saved.serverPid, 'SIGKILL');
  await until(() => !alive(saved.pid) && !alive(saved.serverPid));
  const result = await s.turn('ok', true).result;
  assert.equal(result.code, 75, result.stderr);
  assert.match(result.stderr, /session\.json/);
  assert.ok(
    s
      .rows()
      .some(
        (row) =>
          JSON.stringify(row) ===
          JSON.stringify(['--user', 'stop', saved.unit]),
      ),
  );
  assert.equal(s.state().pid, saved.pid);
});

test('send refuses a dead server before publishing an inbox message or accepting an old result', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('ok', true).result).code, 0);
  const saved = await s.freeze();
  process.kill(saved.serverPid, 'SIGKILL');
  await until(() => !alive(saved.serverPid));
  mkdirSync(join(s.run, 'rounds/002'));
  writeFileSync(
    join(s.run, 'rounds/002/result.json'),
    JSON.stringify({
      exit_code: 0,
      message: 'earlier session',
      changed: [],
      needs_lead_note: [],
      scope_violations: [],
    }),
  );
  const result = await s.turn('ok').result;
  assert.equal(result.code, 75, result.stderr);
  assert.match(result.stderr, /stop/);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(join(s.run, 'inbox/002.json')), false);
});
