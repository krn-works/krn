import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { alive, setup, until } from './state-trust-fixture.ts';

test('stop and stale start refuse forged process and scope identities without signalling a foreign process', {
  concurrency: 5,
}, async (t) => {
  for (const command of ['stop', 'start']) {
    for (const forgery of [
      'foreign-pid',
      'cmdline',
      'start-time',
      'unit',
      'malformed',
      'oversized-cmdline',
      'executable',
      ...(command === 'stop' ? ['driver-pid'] : []),
    ]) {
      t.test(`${command} ${forgery}`, async (t) => {
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
          ...(forgery === 'executable'
            ? { serverExecutable: '/usr/bin/sleep' }
            : {}),
          ...(forgery === 'driver-pid' ? { pid, pidStartTime: start } : {}),
        };
        writeFileSync(
          join(s.run, 'session.json'),
          forgery === 'malformed' ? '{' : JSON.stringify(forged),
        );
        const before = s.rows(s.scopes);
        const result =
          command === 'stop'
            ? await s.launch('stop')
            : await s.turn('ok', true);
        assert.equal(result.code, 65, result.stderr);
        assert.equal(alive(pid), true, 'foreign sleep was killed');
        assert.equal(
          alive(saved.serverPid),
          true,
          'owned server was killed on a mismatch',
        );
        assert.deepEqual(
          s.rows(s.scopes),
          before,
          'mismatch invoked systemctl',
        );
        assert.match(
          result.stderr,
          /invalid record|identity|start time|cmdline|unit/,
        );
      });
    }
  }
});
test('thread and turn roots contain only the real repository and its private tmp', async (t) => {
  const s = setup(t);
  assert.equal((await s.turn('ok', true)).code, 0);
  const requests = s.rows();
  assert.deepEqual(
    requests.find((r) => r.method === 'thread/start').params.config
      .sandbox_workspace_write.writable_roots,
    [s.repo, join(s.run, 'tmp')],
  );
  assert.deepEqual(
    requests.find((r) => r.method === 'turn/start').params.sandboxPolicy
      .writableRoots,
    [s.repo, join(s.run, 'tmp')],
  );
});
test('a host shell TMPDIR cannot move worker scratch files out of the run tmp', async (t) => {
  const s = setup(t);
  const host = join(s.root, 'host-tmp');
  mkdirSync(host);
  s.env.CODEX_TEST_HOST_TMPDIR = host;
  const result = await s.turn('tmpwrite scratch', true);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(existsSync(join(s.run, 'tmp/scratch')), 'scratch not in run tmp');
  assert.ok(!existsSync(join(host, 'scratch')), 'scratch in host tmp');
  const config = s.rows().find((r) => r.method === 'thread/start')
    .params.config;
  for (const key of ['TMPDIR', 'TMP', 'TEMP'])
    assert.equal(
      config[`shell_environment_policy.set.${key}`],
      join(s.run, 'tmp'),
    );
});
