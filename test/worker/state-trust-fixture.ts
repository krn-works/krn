import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { systemctlStub } from './systemctl-stub.ts';

export const cli = resolve('src/cli/krn.mjs');
export const fixture = resolve('test/fixtures/worker/app-server.mjs');
export function alive(pid: number) {
  try {
    process.kill(pid, 0);
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
export function setup(t: TestContext) {
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
    systemctl: systemctlStub(scopes),
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
  // Polls race the fixture's appends, so only newline-terminated rows count.
  const rows = (path = log) =>
    existsSync(path)
      ? readFileSync(path, 'utf8')
          .split('\n')
          .slice(0, -1)
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
