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
test('partial-named exits 4', async (t) => {
  const s = await setup(t);
  const result = await s.turn('partial-named', true);
  assert.equal(result.code, 4, result.stderr);
  assert.match(result.stderr, /status: partial\nblocker: tests missing/);
});

test('report outcomes are visible on start and send', async (t) => {
  for (const [action, code, pattern] of [
    ['blocked-named', 4, /status: blocked\nblocker: npm test exit 1/],
    ['partial-empty', 4, /names no blocker.*\nstatus: partial/s],
    ['blocked-empty', 4, /names no blocker.*\nstatus: blocked/s],
    ['partial-blank', 4, /names no blocker/],
    ['blocked-blank', 4, /names no blocker/],
    ['done-clean', 0, /status: done/],
    ['done-failing', 0, /status: done\nfailing check: npm test exit 1/],
    ['ok', 0, /status: done/],
    ['scope-partial', 3, /scope violation/],
    ['invalid', 4, /status: none/],
  ] as const) {
    await t.test(action, async (t) => {
      const s = await setup(t);
      for (const first of [true, false]) {
        if (action === 'scope-partial' && !first) break;
        const result = await s.turn(
          action,
          first,
          action === 'scope-partial' ? ['--allow', 'src/**'] : [],
        );
        assert.equal(result.code, code, result.stderr);
        assert.match(code ? result.stderr : result.stdout, pattern);
        if (action === 'ok' || action === 'done-clean')
          assert.doesNotMatch(result.stdout, /failing check/);
      }
    });
  }
});

test('rollout path is bounded, absolute, redacted and present each round', async (t) => {
  for (const path of [
    '/tmp/rollout.jsonl',
    'relative',
    null,
    `/${'ą'.repeat(2048)}`,
    '/tmp/sk-synthetic-secret',
  ]) {
    await t.test(String(path)?.slice(0, 40) ?? 'null', async (t) => {
      const s = await setup(t);
      s.env.CODEX_TEST_WORKER_THREAD_PATH = JSON.stringify(path);
      for (const [round, first] of [
        ['001', true],
        ['002', false],
      ] as const) {
        assert.equal((await s.turn('ok', first)).code, 0);
        assert.equal(
          s.json(`rounds/${round}/result.json`).rollout_path,
          path === '/tmp/rollout.jsonl'
            ? path
            : path === '/tmp/sk-synthetic-secret'
              ? '/tmp/[redacted]'
              : null,
        );
      }
    });
  }
});

test('report text is redacted, single line and bounded', async (t) => {
  const s = await setup(t);
  const blockers = [
    'secret sk-synthetic-secret\r\nnext\u001b',
    'ą'.repeat(600),
    ...Array.from({ length: 21 }, (_, i) => `block ${i}`),
  ];
  writeFileSync(
    s.env.CODEX_TEST_WORKER_REPORT ?? '',
    JSON.stringify({
      status: 'blocked',
      canary: '',
      summary: '',
      changed_paths: [],
      findings: [],
      unverified: [],
      blockers,
      checks: Array.from({ length: 23 }, () => ({
        cmd: `${'ą'.repeat(600)}\ncmd`,
        exit_code: -1,
        note: '',
      })),
    }),
  );
  const result = await s.turn('custom-report', true);
  assert.equal(result.code, 4);
  assert.doesNotMatch(result.stderr, /sk-synthetic|\r/);
  assert.ok(!result.stderr.includes(String.fromCharCode(27)));
  assert.match(result.stderr, /blocker: secret \[redacted\] {2}next /);
  assert.match(result.stderr, /truncated; see rounds\/001\/report.json/);
  assert.equal(
    result.stderr.split('\n').filter((x) => x.startsWith('blocker:')).length,
    20,
  );
  assert.equal(
    result.stderr.split('\n').filter((x) => x.startsWith('failing check:'))
      .length,
    20,
  );
  for (const line of result.stderr.split('\n')) {
    if (line.startsWith('blocker: '))
      assert.ok(Buffer.byteLength(line.slice('blocker: '.length)) <= 512);
    if (line.startsWith('failing check: '))
      assert.ok(
        Buffer.byteLength(
          line.slice('failing check: '.length).replace(/ exit -1$/, ''),
        ) <= 512,
      );
  }
  assert.equal(
    result.stderr.split('\n').filter((x) => x === '… 3 more').length,
    2,
  );
});

test('old result files still parse', async () => {
  const { resultSchema } = await import('../../src/worker/state.ts');
  assert.ok(
    resultSchema.safeParse({
      exit_code: 0,
      message: 'done',
      changed: [],
      needs_lead_note: [],
      scope_violations: [],
    }).success,
  );
});

test('timeout without a report prints none and preserves exit 124', async (t) => {
  const s = await setup(t);
  const result = await s.turn('hang', true, ['--timeout-min', '0.02']);
  assert.equal(result.code, 124, result.stderr);
  assert.match(result.stderr, /status: none/);
});
