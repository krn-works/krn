import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const cli = resolve('src/cli/krn.mjs');
const fixture = resolve('test/fixtures/worker/app-server.mjs');
function alive(pid: number) {
  if (pid <= 1) return false;
  try {
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
function signalPending(pid: number) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  return [...status.matchAll(/^(?:SigPnd|ShdPnd):\s+([a-f0-9]+)/gm)].some(
    (match) => (BigInt(`0x${match[1]}`) & (1n << 14n)) !== 0n,
  );
}
async function setup(t: TestContext) {
  const module = await import('../../src/worker/state.ts').catch(
    () => undefined,
  );
  assert.equal(typeof module?.readJson, 'function', 'worker state is missing');
  assert.ok(module);
  const root = mkdtempSync(join(tmpdir(), 'krn-worker-recovery-'));
  const repo = join(root, 'repo');
  const run = join(repo, '.krn/runs/worker');
  const bin = join(root, 'bin');
  const scopes = join(root, 'scopes.jsonl');
  const orphan = join(root, 'orphan-pid');
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
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    KRN_LEGACY_ENTRY: cli,
    KRN_CODEX_BIN: fixture,
    CODEX_TEST_WORKER_LOG: join(root, 'requests.jsonl'),
    CODEX_TEST_WORKER_PID: join(root, 'server-pid'),
    CODEX_TEST_WORKER_ORPHAN_PID: orphan,
    CODEX_TEST_WORKER_VERSION: '0.166.0',
  };
  for (const [name, source] of Object.entries({
    'systemd-run':
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in --unit) shift 2;; --*) shift;; *) exec "$@";; esac; done\n',
    systemctl: `#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(scopes)}, JSON.stringify(args) + '\\n');
const unit = 'krn-worker-' + createHash('sha256').update(realpathSync(${JSON.stringify(run)})).digest('hex') + '.scope';
if (args[1] === 'stop') {
  if (args[2] !== unit) process.exit(65);
  if (existsSync(${JSON.stringify(orphan)})) {
    try { process.kill(Number(readFileSync(${JSON.stringify(orphan)}, 'utf8')), 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
console.log('ActiveState=inactive\\nControlGroup=');
`,
  })) {
    writeFileSync(join(bin, name), source);
    chmodSync(join(bin, name), 0o755);
  }
  const state = () =>
    module.readJson(join(run, 'session.json'), module.sessionSchema);
  const owned = new Set<number>();
  let blockedDriver = false;
  function launch(...args: string[]) {
    if (
      args[0] === 'start' &&
      !existsSync(join(run, 'session.json')) &&
      existsSync(join(run, 'driver.lock'))
    )
      blockedDriver = true;
    const child = spawn(
      process.execPath,
      [cli, 'worker', ...args, '--run', run],
      { env },
    );
    let stderr = '';
    let stdout = '';
    let finished = false;
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    const result = new Promise<{
      code: number | null;
      stderr: string;
      stdout: string;
    }>((done) => {
      child.once('close', (code) => {
        finished = true;
        done({ code, stderr, stdout });
      });
    });
    return {
      result,
      get finished() {
        return finished;
      },
    };
  }
  let messages = 0;
  function turn(text: string, first = false) {
    const input = join(root, `input-${++messages}`);
    writeFileSync(input, text);
    return launch(
      first ? 'start' : 'send',
      ...(first ? ['--repo', repo, '--brief'] : ['--message']),
      input,
    );
  }
  const rows = () =>
    existsSync(scopes)
      ? readFileSync(scopes, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  t.after(async () => {
    if (!blockedDriver && existsSync(join(run, 'session.json'))) {
      await until(() => {
        const saved = state();
        return saved.pid > 1 && (saved.serverPid > 1 || !alive(saved.pid));
      });
      const saved = state();
      owned.add(saved.pid);
      owned.add(saved.serverPid);
    }
    if (existsSync(orphan)) owned.add(Number(readFileSync(orphan, 'utf8')));
    for (const pid of owned) {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
    await until(() => [...owned].every((pid) => !alive(pid)));
    rmSync(root, { recursive: true, force: true });
  });
  async function freeze() {
    const saved = state();
    owned.add(saved.pid);
    owned.add(saved.serverPid);
    process.kill(saved.pid, 'SIGSTOP');
    await until(() =>
      readFileSync(`/proc/${saved.pid}/status`, 'utf8').includes('State:\tT'),
    );
    return saved;
  }
  const unit = () =>
    `krn-worker-${createHash('sha256').update(realpathSync(run)).digest('hex')}.scope`;
  return {
    root,
    run,
    env,
    state,
    launch,
    turn,
    rows,
    freeze,
    orphan,
    owned,
    unit,
  };
}

test('stop recovers a missing server before the driver records dead and stops its remaining scope members', async (t) => {
  for (const driver of ['live', 'dead']) {
    await t.test(driver, async (t) => {
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

test('start refuses every prior session artefact by name before spawning a driver', async (t) => {
  for (const artefact of [
    'error.json',
    'rounds',
    'closed-session.json',
    'inbox',
    'stop',
    'summary.json',
    'driver.lock',
  ]) {
    for (const shape of ['valid', 'malformed']) {
      await t.test(`${artefact} ${shape}`, async (t) => {
        const s = await setup(t);
        mkdirSync(s.run, { recursive: true });
        const path = join(s.run, artefact);
        if (artefact === 'rounds' || artefact === 'inbox') {
          mkdirSync(path);
          if (shape === 'malformed') {
            const directory = join(path, '002');
            mkdirSync(directory);
            writeFileSync(join(directory, 'result.json'), '{');
          }
        } else
          writeFileSync(
            path,
            shape === 'malformed'
              ? '{'
              : JSON.stringify({ exit_code: 91, message: 'earlier session' }),
          );
        const result = await s.turn('ok', true).result;
        assert.equal(result.code, 75, result.stderr);
        assert.ok(result.stderr.includes(artefact), result.stderr);
        assert.equal(
          existsSync(join(s.run, 'session.json')),
          false,
          'refused start spawned a driver',
        );
        assert.equal(existsSync(s.env.CODEX_TEST_WORKER_PID), false);
        assert.deepEqual(s.rows(), []);
      });
    }
  }
});

test('restart after an initialization error and stop refuses the old error without a new driver', async (t) => {
  const s = await setup(t);
  s.env.CODEX_TEST_WORKER_VERSION = '0.0.0';
  assert.equal((await s.turn('ok', true).result).code, 65);
  await until(
    () => existsSync(join(s.run, 'summary.json')) && !alive(s.state().pid),
  );
  assert.equal((await s.launch('stop').result).code, 0);
  const before = s.rows();
  s.env.CODEX_TEST_WORKER_VERSION = '0.166.0';
  const result = await s.turn('ok', true).result;
  assert.equal(result.code, 75, result.stderr);
  assert.match(result.stderr, /error\.json/);
  assert.equal(existsSync(join(s.run, 'session.json')), false);
  assert.deepEqual(s.rows(), before);
});

test('send and stop never consume closed-session results or errors', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('ok', true).result).code, 0);
  assert.equal((await s.launch('stop').result).code, 0);
  writeFileSync(join(s.run, 'error.json'), '{');
  const before = s.rows();
  const sent = await s.turn('ok').result;
  assert.equal(sent.code, 65, sent.stderr);
  assert.match(sent.stderr, /session\.json/);
  assert.equal((await s.launch('stop').result).code, 0);
  assert.deepEqual(s.rows(), before);
});
