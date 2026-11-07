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
test('live thread reuses identity, validates reports, accounts uncached tokens and explicit effort', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('ok', true)).code, 0);
  assert.equal(
    (await s.turn('ok', false, ['--effort', 'low', '--model', 'gpt-6-luna']))
      .code,
    0,
  );
  const calls = s.requests();
  assert.equal(calls.filter((x) => x.method === 'initialize').length, 1);
  assert.equal(calls.filter((x) => x.method === 'thread/start').length, 1);
  const turns = calls.filter((x) => x.method === 'turn/start');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].params.threadId, turns[1].params.threadId);
  assert.equal(turns[0].params.effort, 'medium');
  assert.equal(turns[1].params.effort, 'low');
  assert.ok(turns[0].params.outputSchema.required.includes('status'));
  const policy = calls.find((x) => x.method === 'thread/start').params;
  assert.equal(policy.sandbox, 'workspace-write');
  assert.equal(policy.approvalPolicy, 'never');
  assert.equal(s.json('rounds/001/report.json').status, 'done');
  assert.equal(
    s.json('rounds/002/metrics.json').cumulative.uncached_total,
    170,
  );
  assert.equal((await s.command('stop')).code, 0);
  assert.equal(s.json('summary.json').tokens, 170);
  const pid = Number(readFileSync(s.env.CODEX_TEST_WORKER_PID, 'utf8'));
  assert.throws(() => process.kill(pid, 0));
});
test('forbidden paths and symlinks fail even with allow, retain thread for repair', {
  concurrency: 4,
}, async (t) => {
  for (const path of [
    'tasks/x.json',
    'AGENTS.md',
    'nested/CLAUDE.md',
    '.codex/config.toml',
    '.krn/other/x',
    'mise.toml',
    'new-link',
  ]) {
    t.test(path, async (t) => {
      const s = await setup(t);
      const result = await s.turn(
        `${path === 'new-link' ? 'link' : 'write'} ${path}`,
        true,
        ['--allow', '**'],
      );
      assert.equal(result.code, 3, result.stderr);
      assert.match(result.stderr, new RegExp(path.replaceAll('.', '\\.')));
      rmSync(join(s.repo, path));
      assert.equal((await s.turn('ok')).code, 0);
    });
  }
});
test('review tier needs lead note; policy comes from start commit', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('write docs/guide.md', true)).code, 0);
  assert.deepEqual(s.json('rounds/001/result.json').needs_lead_note, [
    'docs/guide.md',
  ]);
  writeFileSync(join(s.repo, 'spec/worker-scope.json'), '{}');
  assert.equal((await s.turn('write tasks/x.json')).code, 3);
});
test('approval request is declined and fails the round', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('approval', true)).code, 70);
  assert.deepEqual(s.requests().find((x) => x.id === 'approval').result, {
    decision: 'decline',
  });
});
test('compaction precedes next turn and fourth turn is refused', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('large', true)).code, 0);
  assert.equal((await s.turn('ok')).code, 0);
  assert.equal((await s.turn('ok')).code, 0);
  assert.equal((await s.turn('ok')).code, 5);
  const methods = s.requests().map((x) => x.method);
  assert.ok(
    methods.indexOf('thread/compact/start') < methods.lastIndexOf('turn/start'),
  );
  assert.equal(methods.filter((x) => x === 'turn/start').length, 3);
});
test('cumulative uncached budget refuses next send', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('budget', true)).code, 0);
  assert.equal((await s.turn('ok')).code, 5);
});
test('timeout interrupts and stop reaps the owned server', async (t) => {
  const s = await setup(t);
  assert.equal(
    (await s.turn('hang', true, ['--timeout-min', '0.002'])).code,
    124,
  );
  assert.ok(s.requests().some((x) => x.method === 'turn/interrupt'));
  assert.equal((await s.command('stop')).code, 0);
  assert.throws(() =>
    process.kill(Number(readFileSync(s.env.CODEX_TEST_WORKER_PID, 'utf8')), 0),
  );
});
test('server crash fails promptly and next send refuses a dead thread', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('crash', true)).code, 75);
  assert.equal((await s.turn('ok')).code, 5);
});
test('invalid reports and malformed protocol are bounded failures', {
  concurrency: 3,
}, async (t) => {
  for (const [action, code] of [
    ['invalid', 4],
    ['oversized', 4],
    ['malformed', 65],
    ['crlf', 65],
    ['bom', 65],
    ['line-limit', 65],
  ] as const)
    t.test(action, async (t) => {
      const s = await setup(t);
      assert.equal((await s.turn(action, true)).code, code);
    });
});
test('unknown app-server version is refused', async (t) => {
  const s = await setup(t);
  s.env.CODEX_TEST_WORKER_VERSION = '9.0.0';
  assert.equal((await s.turn('ok', true)).code, 65);
});
test('run and inbox symlinks, corrupt metrics and stale state fail closed', async (t) => {
  const s = await setup(t);
  mkdirSync(join(s.repo, '.krn/runs'), { recursive: true });
  symlinkSync(s.root, s.run);
  assert.equal((await s.turn('ok', true)).code, 65);
  rmSync(s.run);
  assert.equal((await s.turn('ok', true)).code, 0);
  const inbox = join(s.run, 'inbox');
  rmSync(inbox, { recursive: true });
  symlinkSync(s.root, inbox);
  assert.equal((await s.turn('ok')).code, 65);
  rmSync(inbox);
  mkdirSync(inbox);
  const state = readFileSync(join(s.run, 'session.json'));
  writeFileSync(join(s.run, 'session.json'), '{');
  assert.equal((await s.turn('ok')).code, 65);
  writeFileSync(join(s.run, 'session.json'), state);
  writeFileSync(join(s.run, 'client.lock'), '');
  assert.equal((await s.turn('ok')).code, 75);
  rmSync(join(s.run, 'client.lock'));
  writeFileSync(join(s.run, 'rounds/001/metrics.json'), '{');
  assert.equal((await s.turn('ok')).code, 65);
  assert.equal((await s.command('stop')).code, 0);
  const stale = {
    ...s.json('closed-session.json'),
    pid: 2147483647,
    status: 'running',
  };
  writeFileSync(join(s.run, 'session.json'), JSON.stringify(stale));
  assert.equal((await s.turn('ok', true)).code, 75);
  assert.equal((await s.command('stop')).code, 0);
});
test('stop interrupts an active turn while the client is waiting', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('ok', true)).code, 0);
  const pending = s.turn('hang');
  const deadline = Date.now() + 10000;
  while (s.requests().filter((x) => x.method === 'turn/start').length < 2) {
    assert.ok(Date.now() < deadline, 'turn did not start');
    await new Promise(setImmediate);
  }
  assert.equal((await s.command('stop')).code, 0);
  assert.equal((await pending).code, 75);
});
