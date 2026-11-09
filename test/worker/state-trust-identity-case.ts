import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { alive, setup, until } from './state-trust-fixture.ts';

// One forged session.json identity against `stop` or a stale `start`: the
// command must exit 65 without signalling the foreign process or the owned
// server and without invoking systemctl. The stop and start suites are
// separate files so each runs under the 11 s CI file bound.
export const FORGERIES = [
  'foreign-pid',
  'cmdline',
  'start-time',
  'unit',
  'malformed',
  'oversized-cmdline',
  'executable',
] as const;

export async function refusesForgedIdentity(
  t: TestContext,
  command: 'stop' | 'start',
  forgery: (typeof FORGERIES)[number] | 'driver-pid',
): Promise<void> {
  const s = setup(t);
  assert.equal((await s.turn('ok', true)).code, 0);
  const pending = s.turn('hang-orphan');
  await until(
    () => s.rows().filter((r) => r.method === 'turn/start').length === 2,
  );
  const saved = s.state();
  process.kill(saved.pid, 'SIGKILL');
  assert.equal((await pending).code, 75);
  await until(() => !alive(saved.pid));
  const foreign = spawn(
    forgery === 'oversized-cmdline' ? process.execPath : 'sleep',
    forgery === 'oversized-cmdline'
      ? ['-e', 'setInterval(() => {}, 1000)', '--', 'x'.repeat(65536)]
      : ['300'],
    {
      detached: true,
      stdio: 'ignore',
    },
  );
  await new Promise<void>((done) => foreign.once('spawn', done));
  const pid = foreign.pid;
  assert.ok(pid);
  s.owned.add(pid);
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const start = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/)[19];
  const forged = {
    ...saved,
    ...(forgery === 'foreign-pid' ||
    forgery === 'cmdline' ||
    forgery === 'oversized-cmdline'
      ? { serverPid: pid, serverGroup: pid }
      : {}),
    ...(forgery === 'cmdline' || forgery === 'oversized-cmdline'
      ? { serverStartTime: start }
      : {}),
    ...(forgery === 'start-time' ? { serverStartTime: '1' } : {}),
    ...(forgery === 'unit' ? { unit: 'krn-worker-foreign.scope' } : {}),
    ...(forgery === 'executable' ? { serverExecutable: '/usr/bin/sleep' } : {}),
    ...(forgery === 'driver-pid' ? { pid, pidStartTime: start } : {}),
  };
  writeFileSync(
    join(s.run, 'session.json'),
    forgery === 'malformed' ? '{' : JSON.stringify(forged),
  );
  const before = s.rows(s.scopes);
  const result =
    command === 'stop' ? await s.launch('stop') : await s.turn('ok', true);
  assert.equal(result.code, 65, result.stderr);
  assert.equal(alive(pid), true, 'foreign sleep was killed');
  assert.equal(
    alive(saved.serverPid),
    true,
    'owned server was killed on a mismatch',
  );
  assert.deepEqual(s.rows(s.scopes), before, 'mismatch invoked systemctl');
  assert.match(
    result.stderr,
    /invalid record|identity|start time|cmdline|unit/,
  );
}
