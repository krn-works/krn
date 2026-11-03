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
import { test } from 'node:test';

const cli = resolve('src/cli/krn.mjs');
const fixture = resolve('test/fixtures/worker/app-server.mjs');
async function setup(t: import('node:test').TestContext) {
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
  for (const [name, source] of Object.entries({
    'systemd-run':
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in --unit) shift 2;; --*) shift;; *) exec "$@";; esac; done\n',
    systemctl: '#!/bin/sh\nprintf "ActiveState=inactive\\nControlGroup=\\n"\n',
  })) {
    writeFileSync(join(bin, name), source);
    chmodSync(join(bin, name), 0o755);
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    KRN_CODEX_BIN: fixture,
    KRN_LEGACY_ENTRY: cli,
    CODEX_TEST_WORKER_LOG: join(root, 'requests.jsonl'),
    CODEX_TEST_WORKER_VERSION: '0.166.0',
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

for (const [name, extra] of [
  ['the compaction item', {}],
  [
    'the deprecated thread/compacted',
    { CODEX_TEST_WORKER_COMPACTED_NOTIFICATION: '1' },
  ],
] as const)
  test(`a turn starts only after ${name} of its own thread`, async (t) => {
    const s = await setup(t);
    Object.assign(s.env, { CODEX_TEST_WORKER_SLOW_COMPACTION: '1', ...extra });
    assert.equal(
      (await s.turn('large', true, ['--timeout-min', '0.1'])).code,
      0,
    );
    const sent = await s.turn('ok');
    assert.equal(sent.code, 0, sent.stderr);
    assert.equal(s.json('rounds/002/metrics.json').compacted, true);
    const methods = s.requests().map((x) => x.method);
    assert.ok(
      methods.indexOf('thread/compact/start') <
        methods.lastIndexOf('turn/start'),
    );
  });
test('send --compact always compacts a small thread before its turn', async (t) => {
  const s = await setup(t);
  Object.assign(s.env, { CODEX_TEST_WORKER_SLOW_COMPACTION: '1' });
  assert.equal((await s.turn('ok', true)).code, 0);
  const sent = await s.turn('ok', false, ['--compact', 'always']);
  assert.equal(sent.code, 0, sent.stderr);
  assert.equal(s.json('rounds/002/metrics.json').compacted, true);
  assert.equal(
    s.requests().filter((x) => x.method === 'thread/compact/start').length,
    1,
  );
});
test('send without --compact keeps a small thread uncompacted', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('ok', true)).code, 0);
  assert.equal((await s.turn('ok')).code, 0);
  assert.equal(s.json('rounds/002/metrics.json').compacted, false);
});
test('--compact is refused outside send', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('ok', true, ['--compact', 'always'])).code, 64);
  assert.equal((await s.turn('ok', true)).code, 0);
  assert.equal((await s.turn('ok', false, ['--compact', 'never'])).code, 64);
});
test('compaction counts against the round timeout', async (t) => {
  const s = await setup(t);
  Object.assign(s.env, {
    CODEX_TEST_WORKER_SLOW_COMPACTION: '1',
    CODEX_TEST_WORKER_COMPACT_ACK_MS: '3000',
  });
  assert.equal((await s.turn('ok', true, ['--timeout-min', '0.02'])).code, 0);
  const sent = await s.turn('ok', false, ['--compact', 'always']);
  assert.equal(sent.code, 124, sent.stderr);
  const methods = s.requests().map((x) => x.method);
  assert.equal(methods.filter((x) => x === 'turn/start').length, 1);
  // No turn started, so the timeout neither interrupts nor waits on one.
  assert.equal(methods.includes('turn/interrupt'), false);
  assert.equal(s.json('session.json').status, 'dead');
});
