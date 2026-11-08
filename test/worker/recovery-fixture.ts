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
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const cli = resolve('src/cli/krn.mjs');
const fixture = resolve('test/fixtures/worker/app-server.mjs');
export function alive(pid: number) {
  if (pid <= 1) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch {
    return false;
  }
}
export async function until(condition: () => boolean) {
  const deadline = Date.now() + 20000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'condition did not become true');
    await delay(10);
  }
}
export function signalPending(pid: number) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  return [...status.matchAll(/^(?:SigPnd|ShdPnd):\s+([a-f0-9]+)/gm)].some(
    (match) => (BigInt(`0x${match[1]}`) & (1n << 14n)) !== 0n,
  );
}
export async function setup(t: TestContext) {
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
    CODEX_TEST_WORKER_VERSION: '0.167.0',
    CODEX_TEST_WORKER_PROBE_VERSION: '',
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
          .split('\n')
          .slice(0, -1)
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
