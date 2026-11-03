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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    KRN_CODEX_BIN: fixture,
    KRN_LEGACY_ENTRY: cli,
    CODEX_TEST_WORKER_LOG: join(root, 'requests.jsonl'),
    CODEX_TEST_WORKER_VERSION: '0.166.0',
    CODEX_TEST_WORKER_PID: join(root, 'pid'),
    CODEX_TEST_WORKER_REPORT: join(root, 'report'),
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
    readFileSync(env.CODEX_TEST_WORKER_LOG ?? '', 'utf8')
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line));
  t.after(async () => {
    await command('stop');
    rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, run, env, command, turn, json, requests };
}
test('required output missing refuses done', async (t) => {
  const s = await setup(t);
  const r = await s.turn('done-without-writing', true, ['--require', 'a.txt']);
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /missing required output a.txt/);
  const send = await s.turn('ok');
  assert.equal(send.code, 4, send.stderr);
  assert.match(send.stderr, /missing required output a.txt/);
});
test('required output written succeeds cumulatively', async (t) => {
  const s = await setup(t);
  assert.equal(
    (await s.turn('write a.txt', true, ['--require', 'a.txt'])).code,
    0,
  );
  assert.equal((await s.turn('ok')).code, 0);
});
test('deletion does not satisfy required output', async (t) => {
  const s = await setup(t);
  writeFileSync(join(s.repo, 'a.txt'), 'base');
  for (const args of [
    ['add', '.'],
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'file',
    ],
  ])
    assert.equal(spawnSync('git', ['-C', s.repo, ...args]).status, 0);
  const r = await s.turn('delete a.txt', true, ['--require', 'a.txt']);
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /missing required output a.txt/);
});
test('invalid required paths never start a turn', async (t) => {
  for (const paths of [
    ['../x'],
    ['/abs'],
    ['*'],
    ['a/'],
    ['a/../b'],
    ['a', 'a'],
    ['x'.repeat(4097)],
    Array.from({ length: 65 }, (_, i) => `a${i}`),
  ]) {
    const s = await setup(t);
    const r = await s.turn(
      'ok',
      true,
      paths.flatMap((p) => ['--require', p]),
    );
    assert.equal(r.code, 64, r.stderr);
    assert.equal(existsSync(s.env.CODEX_TEST_WORKER_LOG ?? ''), false);
  }
});
test('scope violation wins over required output including symlinks', async (t) => {
  for (const action of ['write AGENTS.md', 'link a.txt']) {
    const s = await setup(t);
    const r = await s.turn(action, true, ['--require', 'a.txt']);
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, /scope violation/);
  }
});
test('old session defaults required paths', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('ok', true)).code, 0);
  const { sessionSchema } = await import('../../src/worker/state.ts');
  const old = s.json('session.json');
  delete old.requires;
  assert.deepEqual(sessionSchema.parse(old).requires, []);
});
