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

export const cli = resolve('src/cli/krn.mjs');
export const fixture = resolve('test/fixtures/worker/app-server.mjs');
/** Writes systemd stubs into bin: the scope runs its command inline and reads as gone. */
export function stubSystemd(bin: string): void {
  for (const [name, source] of Object.entries({
    'systemd-run':
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in --unit) shift 2;; --*) shift;; *) exec "$@";; esac; done\n',
    systemctl: '#!/bin/sh\nprintf "ActiveState=inactive\\nControlGroup=\\n"\n',
  })) {
    writeFileSync(join(bin, name), source);
    chmodSync(join(bin, name), 0o755);
  }
}
export async function setup(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'krn-worker-'));
  const repo = join(root, 'repo');
  const run = join(repo, '.krn/runs/worker');
  const bin = join(root, 'bin');
  mkdirSync(join(repo, 'spec'), { recursive: true });
  mkdirSync(bin);
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
  stubSystemd(bin);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    KRN_CODEX_BIN: fixture,
    KRN_LEGACY_ENTRY: cli,
    CODEX_TEST_WORKER_LOG: join(root, 'requests.jsonl'),
    CODEX_TEST_WORKER_VERSION: '0.167.0',
    CODEX_TEST_WORKER_PID: join(root, 'pid'),
  };
  async function command(...args: string[]) {
    const child = spawn(
      process.execPath,
      [cli, 'worker', ...args, '--run', run],
      { env },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => {
      stdout += b;
    });
    child.stderr.on('data', (b) => {
      stderr += b;
    });
    const code = await new Promise<number | null>((done) =>
      child.on('close', done),
    );
    return { code, stdout, stderr };
  }
  let message = 0;
  async function turn(text: string, first = false, extra: string[] = []) {
    const file = join(root, `message-${++message}.md`);
    writeFileSync(file, text);
    return command(
      first ? 'start' : 'send',
      ...(first ? ['--repo', repo, '--brief'] : ['--message']),
      file,
      ...extra,
    );
  }
  const json = (path: string) =>
    JSON.parse(readFileSync(join(run, path), 'utf8'));
  const requests = () =>
    readFileSync(env.CODEX_TEST_WORKER_LOG, 'utf8')
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line));
  t.after(async () => {
    await command('stop');
    rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, run, env, command, turn, json, requests };
}
