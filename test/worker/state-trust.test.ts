import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const cli = resolve('src/cli/krn.mjs');
const fixture = resolve('test/fixtures/worker/app-server.mjs');
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch {
    return false;
  }
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 20000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'condition did not become true');
    await delay(10);
  }
}
function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'krn-worker-trust-'));
  const repo = join(root, 'repo');
  const run = join(repo, '.krn/runs/worker');
  const bin = join(root, 'bin');
  const log = join(root, 'requests.jsonl');
  const scopes = join(root, 'scopes.jsonl');
  mkdirSync(join(repo, 'spec'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(repo, '.gitignore'), '.krn/\n');
  writeFileSync(
    join(repo, 'spec/worker-scope.json'),
    existsSync('spec/worker-scope.json')
      ? readFileSync('spec/worker-scope.json')
      : '{}',
  );
  for (const args of [
    ['init', '-q'],
    ['add', '.'],
    [
      '-c',
      'user.name=worker',
      '-c',
      'user.email=worker@example.invalid',
      'commit',
      '-qm',
      'base',
    ],
  ])
    assert.equal(spawnSync('git', ['-C', repo, ...args]).status, 0);
  for (const [name, source] of Object.entries({
    'systemd-run':
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in --unit) shift 2;; --*) shift;; *) exec "$@";; esac; done\n',
    systemctl: `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(scopes)}, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log('ActiveState=inactive\\nControlGroup=');
`,
  })) {
    writeFileSync(join(bin, name), source);
    chmodSync(join(bin, name), 0o755);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    KRN_LEGACY_ENTRY: cli,
    KRN_CODEX_BIN: fixture,
    CODEX_TEST_WORKER_LOG: log,
    CODEX_TEST_WORKER_PID: join(root, 'server-pid'),
  };
  function launch(...args: string[]) {
    const child = spawn(
      process.execPath,
      [cli, 'worker', ...args, '--run', run],
      { env },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.resume();
    return new Promise<{ code: number | null; stderr: string }>((done) => {
      child.once('close', (code) => done({ code, stderr }));
    });
  }
  let messages = 0;
  const owned = new Set<number>();
  const state = () =>
    JSON.parse(readFileSync(join(run, 'session.json'), 'utf8'));
  async function turn(text: string, first = false) {
    const input = join(root, `input-${++messages}`);
    writeFileSync(input, text);
    const result = await launch(
      first ? 'start' : 'send',
      ...(first ? ['--repo', repo, '--brief'] : ['--message']),
      input,
    );
    if (!owned.size && existsSync(join(run, 'session.json'))) {
      const saved = state();
      owned.add(saved.pid);
      owned.add(saved.serverPid);
    }
    return result;
  }
  const rows = (path = log) =>
    existsSync(path)
      ? readFileSync(path, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  t.after(async () => {
    // Only PIDs captured before forging the state belong to this fixture.
    for (const pid of owned) {
      if (pid > 1 && alive(pid)) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
    }
    await until(() => [...owned].every((pid) => !alive(pid)));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, run, env, scopes, launch, turn, state, rows, owned };
}

test('stop and stale start refuse forged process and scope identities without signalling a foreign process', async (t) => {
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
      await t.test(`${command} ${forgery}`, async (t) => {
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

test('a turn cannot change driver files, including the session state, but can use tmp', async (t) => {
  for (const path of [
    'session.json',
    'driver.lock',
    'inbox/forged.json',
    'rounds/001/metrics.json',
    'summary.json',
    'tmp/ok',
  ]) {
    await t.test(path, async (t) => {
      const s = setup(t);
      const result = await s.turn(
        `write ${relative(s.repo, join(s.run, path))}`,
        true,
      );
      assert.equal(result.code, path.startsWith('tmp/') ? 0 : 3, result.stderr);
      if (!path.startsWith('tmp/'))
        assert.match(result.stderr, /scope violation|integrity/);
    });
  }
});

test('tmp symlinks are refused before launching a server', async (t) => {
  const s = setup(t);
  mkdirSync(s.run, { recursive: true });
  symlinkSync(s.root, join(s.run, 'tmp'));
  const result = await s.turn('ok', true);
  assert.equal(result.code, 65, result.stderr);
  assert.equal(s.rows().length, 0);
});

test('state integrity is checked against driver memory before accepting another turn', async (t) => {
  const s = setup(t);
  assert.equal((await s.turn('ok', true)).code, 0);
  const saved = s.state();
  writeFileSync(
    join(s.run, 'session.json'),
    JSON.stringify({ ...saved, serverStartTime: '1' }),
  );
  const result = await s.turn('ok');
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stderr, /integrity/);
  await until(() => !alive(saved.pid) && !alive(saved.serverPid));
  assert.equal(s.rows().filter((r) => r.method === 'turn/start').length, 1);
  assert.equal(s.state().serverStartTime, saved.serverStartTime);
});

test('a turn cannot replace the tmp root with a symlink or create a stop request', async (t) => {
  for (const action of [
    'relink .krn/runs/worker/tmp',
    'write .krn/runs/worker/stop',
  ]) {
    await t.test(action, async (t) => {
      const s = setup(t);
      const result = await s.turn(action, true);
      assert.equal(result.code, 3, result.stderr);
    });
  }
});

test('proc stat parsing uses the last parenthesis for comm names with spaces and parentheses', async () => {
  const module = await import('../../src/worker/process.ts').catch(
    () => undefined,
  );
  assert.equal(
    typeof module?.parseProcessStat,
    'function',
    'worker process parser is missing',
  );
  assert.ok(module);
  assert.deepEqual(
    module.parseProcessStat(
      `42 (worker ) with spaces) S 1 42 ${Array(16).fill('0').join(' ')} 987654 0`,
    ),
    { state: 'S', group: 42, startTime: '987654' },
  );
});
