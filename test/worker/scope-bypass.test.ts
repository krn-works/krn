import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const cli = resolve('src/cli/krn.mjs');
const fixture = resolve('test/fixtures/worker/app-server.mjs');

async function setup(t: TestContext, worktree = false) {
  const root = mkdtempSync(join(tmpdir(), 'krn-worker-scope-'));
  const main = join(root, 'main');
  const repo = worktree ? join(root, 'repo') : main;
  const run = join(repo, '.krn/runs/worker');
  const bin = join(root, 'bin');
  mkdirSync(join(main, 'spec'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(main, '.gitignore'), 'node_modules/\n.krn/\n');
  writeFileSync(
    join(main, 'spec/worker-scope.json'),
    existsSync('spec/worker-scope.json')
      ? readFileSync('spec/worker-scope.json')
      : '{}',
  );
  function git(...args: string[]) {
    const result = spawnSync('git', ['-C', main, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git('init', '-q');
  git('add', '.');
  git(
    '-c',
    'user.name=worker',
    '-c',
    'user.email=worker@example.invalid',
    'commit',
    '-qm',
    'base',
  );
  if (worktree) git('worktree', 'add', '-qb', 'worker', repo);
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
    CODEX_TEST_WORKER_INITIALIZE_GATE: '',
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
    const result = new Promise<{ code: number | null; stderr: string }>(
      (done) => child.on('close', (code) => done({ code, stderr })),
    );
    return { child, result };
  }
  let round = 0;
  function turn(text: string) {
    const path = join(root, `message-${++round}.md`);
    writeFileSync(path, text);
    return launch(
      round === 1 ? 'start' : 'send',
      ...(round === 1 ? ['--repo', repo, '--brief'] : ['--message']),
      path,
      '--allow',
      '**',
    );
  }
  t.after(async () => {
    await launch('stop').result;
    rmSync(root, { recursive: true, force: true });
  });
  const dirs = spawnSync(
    'git',
    [
      '-C',
      repo,
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
      '--git-common-dir',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(dirs.status, 0, dirs.stderr);
  const [gitDir = '', commonDir = ''] = dirs.stdout.trim().split('\n');
  return { root, repo, run, env, turn, launch, gitDir, commonDir };
}

test('worker-created ignores cannot hide forbidden paths or newly created ignored trees', async (t) => {
  for (const path of [
    'AGENTS.md',
    'nested/CLAUDE.md',
    'node_modules/AGENTS.md',
    '.krn/other/AGENTS.md',
  ]) {
    await t.test(path, async (t) => {
      const s = await setup(t);
      const result = await s.turn(`ignore ${path}`).result;
      assert.equal(result.code, 3, result.stderr);
      assert.ok(result.stderr.includes(path), result.stderr);
    });
  }
});

test('baseline ignored trees are skipped while new paths still undergo tiers on every turn', async (t) => {
  const s = await setup(t);
  // More than the per-turn limit already exists; it must never be descended.
  mkdirSync(join(s.repo, 'node_modules/dependency'), { recursive: true });
  for (let i = 0; i <= 10000; i++)
    writeFileSync(
      join(s.repo, 'node_modules/dependency', `${i}.js`),
      'existing',
    );
  mkdirSync(join(s.repo, '.krn/runs/other'), { recursive: true });
  writeFileSync(join(s.repo, '.krn/runs/other/AGENTS.md'), 'existing');
  assert.equal((await s.turn('ok').result).code, 0);
  const result = await s.turn('ignore AGENTS.md').result;
  assert.equal(result.code, 3, result.stderr);
  assert.ok(result.stderr.includes('AGENTS.md'), result.stderr);
});

test('Git config, hooks and info changes are forbidden in repositories and linked worktrees', async (t) => {
  for (const worktree of [false, true]) {
    for (const name of ['config', 'hooks/post-checkout', 'info/attributes']) {
      await t.test(
        `${worktree ? 'worktree' : 'repository'} ${name}`,
        async (t) => {
          const s = await setup(t, worktree);
          const path = join(s.commonDir, name);
          const result = await s.turn(`write ${relative(s.repo, path)}`).result;
          assert.equal(result.code, 3, result.stderr);
          assert.ok(result.stderr.includes(path), result.stderr);
        },
      );
    }
  }
  await t.test('worktree-local config', async (t) => {
    const s = await setup(t, true);
    const path = join(s.gitDir, 'config.worktree');
    const result = await s.turn(`write ${relative(s.repo, path)}`).result;
    assert.equal(result.code, 3, result.stderr);
    assert.ok(result.stderr.includes(path), result.stderr);
  });
});

test('remote-tracking refs written in the shared Git directory during a turn are not violations', async (t) => {
  const s = await setup(t, true);
  const path = join(s.commonDir, 'refs/remotes/origin/feat/memory-refs');
  const shared = await s.turn(`write ${relative(s.repo, path)}`).result;
  assert.equal(shared.code, 0, shared.stderr);
  const forbidden = await s.turn('write AGENTS.md').result;
  assert.equal(forbidden.code, 3, forbidden.stderr);
  assert.ok(forbidden.stderr.includes('AGENTS.md'), forbidden.stderr);
});

test('symlinked hooks are reported without following their targets', async (t) => {
  const s = await setup(t);
  const target = join(s.root, 'outside');
  // A pre-existing link to an unreadable target must be fingerprintable.
  mkdirSync(target, { mode: 0o000 });
  symlinkSync(target, join(s.gitDir, 'hooks/existing'));
  assert.equal((await s.turn('ok').result).code, 0);
  const path = join(s.gitDir, 'hooks/post-checkout');
  const result = await s.turn(`link ${relative(s.repo, path)}`).result;
  assert.equal(result.code, 3, result.stderr);
  assert.ok(result.stderr.includes(path), result.stderr);
  chmodSync(target, 0o700);
  assert.deepEqual(readdirSync(target), []);
});

async function until(condition: () => boolean) {
  const deadline = Date.now() + 20000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'condition did not become true');
    await delay(10);
  }
}

test('start and send inbox records redact credentials before atomic private publication', async (t) => {
  const s = await setup(t);
  const release = join(s.root, 'server-release');
  s.env.CODEX_TEST_WORKER_INITIALIZE_GATE = release;
  const message = 'Bearer abc123 api_key=xyz789 sk-syntheticcredential';
  function inspect(name: string) {
    const inbox = join(s.run, 'inbox', name);
    assert.equal(lstatSync(inbox).mode & 0o777, 0o600);
    const record = JSON.parse(readFileSync(inbox, 'utf8'));
    assert.deepEqual(record, {
      text: 'Bearer [redacted] api_key=[redacted] [redacted]',
      model: 'gpt-6-luna',
      effort: 'medium',
    });
    assert.deepEqual(readdirSync(join(s.run, 'inbox')), [name]);
  }
  let finished = false;
  const first = s.turn(message).result.finally(() => {
    finished = true;
  });
  try {
    await until(() => existsSync(join(s.run, 'inbox/001.json')) || finished);
    assert.ok(
      existsSync(join(s.run, 'inbox/001.json')),
      'start did not publish inbox',
    );
    inspect('001.json');
  } finally {
    writeFileSync(release, 'release');
    await first;
  }
  assert.equal((await first).code, 0);
  const state = JSON.parse(readFileSync(join(s.run, 'session.json'), 'utf8'));
  process.kill(state.pid, 'SIGSTOP');
  finished = false;
  const second = s.turn(message).result.finally(() => {
    finished = true;
  });
  try {
    await until(() => existsSync(join(s.run, 'inbox/002.json')) || finished);
    assert.ok(
      existsSync(join(s.run, 'inbox/002.json')),
      'send did not publish inbox',
    );
    inspect('002.json');
  } finally {
    process.kill(state.pid, 'SIGCONT');
    await second;
  }
  assert.equal((await second).code, 0);
});

test('more than 10000 new untracked paths are refused without silent truncation', async (t) => {
  const s = await setup(t);
  const result = await s.turn('many').result;
  assert.equal(result.code, 65, result.stderr);
  assert.match(result.stderr, /10000/);
});

test('untracked enumeration errors exit 70 instead of checking an incomplete listing', async (t) => {
  const s = await setup(t);
  const result = await s.turn('write .git/index').result;
  assert.equal(result.code, 70, result.stderr);
  assert.match(result.stderr, /enumeration failed/);
});
