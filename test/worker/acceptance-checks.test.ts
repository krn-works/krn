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
test('1: successful check records sandbox boundaries', async (t) => {
  const s = await setup(t);
  const r = await s.turn('done-clean', true, ['--check', 'exit 0']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(s.json('rounds/001/result.json').acceptance[0].exit_code, 0);
  const call = s.requests().find((r) => r.kind === 'sandbox');
  assert.ok(call);
  assert.ok(call.args.includes('sandbox_mode="workspace-write"'));
  assert.ok(
    call.args.some(
      (a: string) => a.includes(s.repo) && a.includes(join(s.run, 'tmp')),
    ),
  );
});
test('2: failed check overrides done and all entries run in order', async (t) => {
  const s = await setup(t);
  const r = await s.turn('done-clean', true, [
    '--check',
    'exit 3',
    '--check',
    'exit 0',
  ]);
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /acceptance: exit 3 exit 3/);
  assert.equal(s.json('rounds/001/report.json').status, 'done');
  assert.deepEqual(
    s
      .json('rounds/001/result.json')
      .acceptance.map((a: { exit_code: number }) => a.exit_code),
    [3, 0],
  );
  const p = await setup(t);
  const partial = await p.turn('partial-named', true, ['--check', 'exit 2']);
  assert.equal(partial.code, 4, partial.stderr);
  assert.match(partial.stderr, /worker report status partial/);
  assert.match(partial.stderr, /acceptance failed/);
  assert.equal(p.json('rounds/001/result.json').acceptance.length, 1);
  const blocked = await setup(t);
  assert.equal(
    (await blocked.turn('blocked-named', true, ['--check', 'exit 0'])).code,
    4,
  );
  assert.equal(blocked.json('rounds/001/result.json').acceptance.length, 1);
  for (const action of ['write AGENTS.md', 'crash']) {
    const skipped = await setup(t);
    assert.notEqual(
      (await skipped.turn(action, true, ['--check', 'exit 0'])).code,
      0,
    );
    assert.equal(
      skipped.requests().filter((r) => r.kind === 'sandbox').length,
      0,
    );
  }
});
test('3: observers written by the turn pass or fail', async (t) => {
  for (const kind of ['pass', 'fail']) {
    const s = await setup(t);
    const r = await s.turn(`observer-${kind}`, true, [
      '--observer',
      `${kind}.test.mjs`,
    ]);
    assert.equal(r.code, kind === 'pass' ? 0 : 4, r.stderr);
    assert.equal(
      s.json('rounds/001/result.json').acceptance[0].kind,
      'observer',
    );
  }
});
test('4: missing and symlink observers fail with a reason', async (t) => {
  for (const linked of [false, true]) {
    const s = await setup(t);
    if (linked) symlinkSync('target', join(s.repo, 'missing.test.ts'));
    const r = await s.turn('done-clean', true, [
      '--observer',
      'missing.test.ts',
    ]);
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, /missing observer missing.test.ts/);
    assert.equal(
      s.json('rounds/001/result.json').acceptance[0].exit_code,
      null,
    );
  }
});
test('5: timeout kills the spawned process group', async (t) => {
  const s = await setup(t);
  s.env.KRN_WORKER_CHECK_TIMEOUT_MS = '500';
  const pidFile = join(s.run, 'tmp', 'check-pid');
  const r = await s.turn('done-clean', true, [
    '--check',
    `echo $$ > "${pidFile}"; sleep 30`,
  ]);
  assert.equal(r.code, 4, r.stderr);
  const entry = s.json('rounds/001/result.json').acceptance[0];
  assert.equal(entry.exit_code, 124);
  assert.equal(entry.timed_out, true);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const deadline = Date.now() + 3000;
  // A killed child reparented to an init that never reaps it (node as PID 1
  // in a pid namespace) stays a zombie, so a zombie counts as dead.
  const alive = () => {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      return false;
    }
    return (
      stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
    );
  };
  while (Date.now() < deadline) {
    if (!alive()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.fail('timed out shell is still alive');
});
test('6: added and removed changed paths both cause drift and preserve failure reasons', async (t) => {
  for (const [action, cmd] of [
    ['done-clean', 'echo edit > new.txt; exit 2'],
    ['write a.txt', 'rm a.txt'],
  ] as const) {
    const s = await setup(t);
    const r = await s.turn(action, true, ['--check', cmd]);
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, /acceptance check modified the worktree/);
    if (cmd.includes('exit 2')) assert.match(r.stderr, /acceptance failed/);
  }
});
test('7: send reruns stored acceptance checks', async (t) => {
  const s = await setup(t);
  assert.equal(
    (await s.turn('done-clean', true, ['--check', 'exit 0'])).code,
    0,
  );
  const r = await s.turn('done-clean');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(s.json('rounds/002/result.json').acceptance[0].exit_code, 0);
  assert.equal(s.requests().filter((r) => r.kind === 'sandbox').length, 2);
});
test('8: invalid or start-only options refuse before state or spawn', async (t) => {
  for (const args of [
    Array.from({ length: 17 }, () => ['--check', 'exit 0']).flat(),
    ['--observer', '../x'],
    ['--observer', '/abs'],
    ['--check', 'x'.repeat(4097)],
    ['--check', ''],
    ['--observer', 'a/../b'],
  ]) {
    const s = await setup(t);
    const r = await s.turn('done-clean', true, args);
    assert.equal(r.code, 64, r.stderr);
    assert.equal(existsSync(join(s.run, 'session.json')), false);
    assert.equal(existsSync(s.env.CODEX_TEST_WORKER_LOG ?? ''), false);
  }
  const s = await setup(t);
  const r = await s.turn('done-clean', false, ['--check', 'x']);
  assert.equal(r.code, 64, r.stderr);
  assert.equal(existsSync(s.env.CODEX_TEST_WORKER_LOG ?? ''), false);
});
test('9: old sessions default lists and reports refuse canary', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('done-clean', true)).code, 0);
  const module = await import('../../src/worker/state.ts');
  assert.equal(typeof module.sessionSchema.parse, 'function');
  const old = s.json('session.json');
  delete old.checks;
  delete old.observers;
  assert.deepEqual(module.sessionSchema.parse(old).checks, []);
  assert.deepEqual(module.sessionSchema.parse(old).observers, []);
  const report = s.json('rounds/001/report.json');
  assert.equal(module.reportSchema.safeParse(report).success, true);
  assert.equal(
    module.reportSchema.safeParse({ ...report, canary: '' }).success,
    false,
  );
  assert.equal(module.acceptanceValueSchema.safeParse('a\0b').success, false);
  assert.equal(
    module.acceptanceValueSchema.safeParse('ą'.repeat(2049)).success,
    false,
  );
});
test('10: output is capped and redacted', async (t) => {
  const s = await setup(t);
  const r = await s.turn('done-clean', true, [
    '--check',
    'printf "sk-"; printf "synthetic-secret\\n"; head -c 1100000 /dev/zero | tr "\\000" x',
  ]);
  assert.equal(r.code, 0, r.stderr);
  const log = readFileSync(join(s.run, 'rounds/001/acceptance-1.log'), 'utf8');
  assert.doesNotMatch(log, /sk-synthetic-secret/);
  assert.match(log, /\[redacted\]/);
  assert.match(log, /\[truncated at 1048576 bytes\]\n$/);
  assert.ok(Buffer.byteLength(log) <= 1048576);
});
test('11: a private key across the log limit or past the capture is redacted', async (t) => {
  for (const [label, tail] of [
    [
      'straddling',
      'printf "MIIEsecretbody\\n-----END RSA PRIV""ATE KEY-----\\n"',
    ],
    ['unterminated', 'head -c 2200000 /dev/zero | tr "\\000" y'],
  ]) {
    const s = await setup(t);
    const r = await s.turn('done-clean', true, [
      '--check',
      `head -c 1048500 /dev/zero | tr "\\000" x; printf "\\n-----BEGIN RSA PRIV""ATE KEY-----\\nMIIEsecretbody\\n"; ${tail}`,
    ]);
    assert.equal(r.code, 0, `${label}: ${r.stderr}`);
    const log = readFileSync(
      join(s.run, 'rounds/001/acceptance-1.log'),
      'utf8',
    );
    assert.doesNotMatch(log, /BEGIN RSA PRIVATE KEY|MIIEsecretbody/, label);
    assert.ok(Buffer.byteLength(log) <= 1048576, label);
  }
});
test('12: a credential-like check or observer is refused, never stored altered', async (t) => {
  for (const args of [
    ['--check', 'printf sk-example'],
    ['--observer', 'sk-example.test.mjs'],
  ]) {
    const s = await setup(t);
    const r = await s.turn('done-clean', true, args);
    assert.equal(r.code, 64, r.stderr);
    assert.match(r.stderr, /looks like a credential/);
    assert.equal(existsSync(join(s.run, 'session.json')), false);
  }
});
