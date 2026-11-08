import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

type WorkerState = typeof import('../../src/worker/state.ts');
const loaded: Partial<WorkerState> = await import(
  '../../src/worker/state.ts'
).catch(() => ({}));
export function worker(): WorkerState {
  assert.equal(
    typeof loaded.atomic,
    'function',
    'worker state module is missing',
  );
  return loaded as WorkerState;
}

export const cli = resolve('src/cli/krn.mjs');
export const fixture = resolve('test/fixtures/worker/app-server.mjs');

export function setup(t: TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), 'krn-worker-input-'));
  const repo = join(root, 'repo');
  const run = join(repo, '.krn/runs/worker');
  const bin = join(root, 'bin');
  fs.mkdirSync(join(repo, 'spec'), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(join(repo, '.gitignore'), '.krn/\n.codex/\nprivate/\n');
  fs.writeFileSync(
    join(repo, 'spec/worker-scope.json'),
    fs.readFileSync('spec/worker-scope.json'),
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
  ]) {
    const result = spawnSync('git', ['-C', repo, ...args]);
    assert.equal(result.status, 0, result.stderr.toString());
  }
  for (const [name, text] of Object.entries({
    'systemd-run':
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in --unit) shift 2;; --*) shift;; *) exec "$@";; esac; done\n',
    systemctl: '#!/bin/sh\nprintf "ActiveState=inactive\\nControlGroup=\\n"\n',
  })) {
    fs.writeFileSync(join(bin, name), text, { mode: 0o755 });
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    KRN_CODEX_BIN: fixture,
    KRN_LEGACY_ENTRY: cli,
    CODEX_TEST_WORKER_LOG: join(root, 'requests.jsonl'),
    CODEX_TEST_WORKER_PID: join(root, 'pid'),
    CODEX_TEST_WORKER_REPORT: join(root, 'report'),
    CODEX_TEST_WORKER_VERSION: '0.167.0',
  };
  function command(args: string[], directory = run) {
    const child = spawn(
      process.execPath,
      [cli, 'worker', ...args, '--run', directory],
      { env },
    );
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    return new Promise<{ code: number | null; stderr: string }>((done) =>
      child.once('close', (code) => done({ code, stderr })),
    );
  }
  let messages = 0;
  function turn(
    text: string,
    first = false,
    extra: string[] = [],
    directory = run,
  ) {
    const path = join(root, `message-${++messages}`);
    fs.writeFileSync(path, text);
    return command(
      [
        first ? 'start' : 'send',
        ...(first ? ['--repo', repo, '--brief'] : ['--message']),
        path,
        ...extra,
      ],
      directory,
    );
  }
  t.after(async () => {
    await command(['stop']);
    for (const name of ['session.json', 'closed-session.json']) {
      const path = join(run, name);
      if (!fs.existsSync(path)) continue;
      const saved = JSON.parse(fs.readFileSync(path, 'utf8'));
      for (const pid of [saved.pid, saved.serverPid]) {
        if (!pid) continue;
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, run, env, command, turn };
}

export function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(path: string) {
    for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) walk(next);
      else result[next] = fs.readFileSync(next, 'hex');
    }
  }
  if (fs.existsSync(root)) walk(root);
  return result;
}

export async function until(condition: () => boolean) {
  const deadline = Date.now() + 20000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'condition did not become true');
    await delay(10);
  }
}
