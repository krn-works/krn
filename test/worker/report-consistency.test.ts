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
test('report cannot name an unchanged path', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('write a.txt', true)).code, 0);
  const r = await s.turn('lie-path');
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /report names unchanged path b.txt/);
  assert.match(r.stderr, /report omits changed path a.txt/);
});
test('report must include cumulative changes', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('write a.txt', true)).code, 0);
  const r = await s.turn('omit-path');
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /report omits changed path a.txt/);
});
test('report normalizes paths and refuses invalid paths', async (t) => {
  for (const kind of ['dot', 'absolute', 'outside', 'control']) {
    const s = await setup(t);
    assert.equal((await s.turn('write a.txt', true)).code, 0);
    const path =
      kind === 'dot'
        ? './a.txt'
        : kind === 'absolute'
          ? join(s.repo, 'a.txt')
          : kind === 'outside'
            ? '../outside'
            : 'bad\npath';
    writeFileSync(
      s.env.CODEX_TEST_WORKER_REPORT ?? '',
      JSON.stringify({
        status: 'done',
        canary: '',
        summary: '',
        changed_paths: [path],
        checks: [],
        findings: [],
        unverified: [],
        blockers: [],
      }),
    );
    const r = await s.turn('custom-report');
    assert.equal(r.code, ['dot', 'absolute'].includes(kind) ? 0 : 4, r.stderr);
  }
});
test('done with a failed check is refused and printed', async (t) => {
  const s = await setup(t);
  const r = await s.turn('done-failing', true);
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /report done with failing check/);
  assert.match(r.stderr, /failing check: npm test exit 1/);
});

test('reasons are bounded per category, sanitized and redacted', async (t) => {
  const s = await setup(t);
  const paths = Array.from(
    { length: 23 },
    (_, i) => `${i}-${'ą'.repeat(600)}\nsecret sk-synthetic-secret`,
  );
  writeFileSync(
    s.env.CODEX_TEST_WORKER_REPORT ?? '',
    JSON.stringify({
      status: 'done',
      canary: '',
      summary: '',
      changed_paths: paths,
      checks: Array.from({ length: 23 }, () => ({
        cmd: `cmd\n${'ą'.repeat(600)}`,
        exit_code: 1,
        note: '',
      })),
      findings: [],
      unverified: [],
      blockers: [],
    }),
  );
  const r = await s.turn('custom-report', true);
  assert.equal(r.code, 4, r.stderr);
  const message = s.json('rounds/001/result.json').message;
  assert.doesNotMatch(message, /[\r\n]|sk-synthetic-secret/);
  assert.equal(
    message.split('; ').filter((part: string) => part === '… 3 more').length,
    2,
  );
  assert.equal(message.split('report names unchanged path ').length - 1, 20);
  assert.match(message, /…/);
});
