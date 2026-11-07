import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

type WorkerState = typeof import('../../src/worker/state.ts');
const loaded: Partial<WorkerState> = await import(
  '../../src/worker/state.ts'
).catch(() => ({}));
function worker(): WorkerState {
  assert.equal(
    typeof loaded.atomic,
    'function',
    'worker state module is missing',
  );
  return loaded as WorkerState;
}

const cli = resolve('src/cli/krn.mjs');
const fixture = resolve('test/fixtures/worker/app-server.mjs');

function setup(t: TestContext) {
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
    CODEX_TEST_WORKER_VERSION: '0.166.0',
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

function snapshot(root: string): Record<string, string> {
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

async function until(condition: () => boolean) {
  const deadline = Date.now() + 20000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'condition did not become true');
    await delay(10);
  }
}

test('grammar-valid model text is redacted in the session and inbox', async (t) => {
  const s = setup(t);
  const release = join(s.root, 'initialize-release');
  s.env.CODEX_TEST_WORKER_INITIALIZE_GATE = release;
  const pending = s.turn('ok', true, ['--model', 'sk-synthetic-model']);
  try {
    const path = join(s.run, 'inbox/001.json');
    await until(() => fs.existsSync(path));
    assert.equal(JSON.parse(fs.readFileSync(path, 'utf8')).model, '[redacted]');
  } finally {
    fs.writeFileSync(release, 'release');
  }
  const result = await pending;
  assert.equal(result.code, 0, result.stderr);
  const session = fs.readFileSync(join(s.run, 'session.json'), 'utf8');
  assert.equal(session.includes('sk-synthetic-model'), false);
  assert.equal(JSON.parse(session).model, '[redacted]');
  const metrics = fs.readFileSync(
    join(s.run, 'rounds/001/metrics.json'),
    'utf8',
  );
  assert.equal(metrics.includes('sk-synthetic-model'), false);
});

// The value grammar is owned by the schemas; the CLI cases below only prove
// each flag is checked before start or send writes anything.
test('model and effort schemas refuse malformed and credential-like values', () => {
  const { modelSchema, effortSchema } = worker();
  for (const value of [
    'Uppercase',
    'bad/model',
    'valid\n',
    'a'.repeat(65),
    'AUTH=synthetic-model',
  ])
    assert.equal(modelSchema.safeParse(value).success, false, value);
  assert.equal(modelSchema.safeParse('a'.repeat(64)).success, true);
  assert.equal(modelSchema.safeParse('gpt-6-luna').success, true);
  for (const value of ['extreme', 'TOKEN: synthetic-effort'])
    assert.equal(effortSchema.safeParse(value).success, false, value);
  assert.equal(effortSchema.safeParse('xhigh').success, true);
});

test('invalid model and effort refuse start and send before writing', {
  concurrency: 6,
}, async (t) => {
  for (const [key, value] of [
    ['--model', 'bad/model'],
    ['--effort', 'extreme'],
  ]) {
    t.test(`${key} ${value}`, async (t) => {
      const s = setup(t);
      const first = await s.turn('ok', true, [key ?? '', value ?? '']);
      assert.equal(first.code, 64, first.stderr);
      assert.equal(fs.existsSync(join(s.repo, '.krn')), false);
      assert.equal((await s.turn('ok', true)).code, 0);
      const before = snapshot(s.run);
      const next = await s.turn('ok', false, [key ?? '', value ?? '']);
      assert.equal(next.code, 64, next.stderr);
      assert.deepEqual(snapshot(s.run), before);
    });
  }
});

test('a missing repo and absent send or stop refuse without creating state', async (t) => {
  const s = setup(t);
  {
    const missing = join(s.root, 'missing');
    const result = await s.command([
      'start',
      '--repo',
      missing,
      '--brief',
      join(s.root, 'brief'),
    ]);
    assert.equal(result.code, 64, result.stderr);
    assert.equal(fs.existsSync(join(s.repo, '.krn')), false);
    assert.equal(
      (await s.command(['send', '--message', join(s.root, 'message')])).code,
      65,
    );
    assert.equal((await s.command(['stop'])).code, 0);
    assert.equal(fs.existsSync(join(s.repo, '.krn')), false);
  }
});

test('other CLI inputs and input files are validated before any writes', {
  concurrency: 6,
}, async (t) => {
  for (const extra of [
    ['--timeout-min', 'NaN'],
    ['--timeout-min', '1e300'],
    ['--allow', 'x'.repeat(4097)],
    Array.from({ length: 101 }, () => ['--allow', '**']).flat(),
    ['--allow', 'AUTH=synthetic-secret'],
  ]) {
    t.test(extra[0] ?? 'arguments', async (t) => {
      const s = setup(t);
      const result = await s.turn('ok', true, extra);
      assert.equal(result.code, 64, result.stderr);
      assert.equal(fs.existsSync(join(s.repo, '.krn')), false);
    });
  }
  t.test('missing brief', async (t) => {
    const s = setup(t);
    assert.equal((await s.command(['start', '--repo', s.repo])).code, 64);
    assert.equal(fs.existsSync(join(s.repo, '.krn')), false);
  });
  t.test('oversized brief', async (t) => {
    const s = setup(t);
    assert.equal((await s.turn('x'.repeat(256 * 1024 + 1), true)).code, 65);
    assert.equal(fs.existsSync(join(s.repo, '.krn')), false);
  });
  t.test('missing input file', async (t) => {
    const s = setup(t);
    const result = await s.command([
      'start',
      '--repo',
      s.repo,
      '--brief',
      join(s.root, 'missing'),
    ]);
    assert.equal(result.code, 65, result.stderr);
    assert.equal(fs.existsSync(join(s.repo, '.krn')), false);
  });
  t.test('redaction expansion is bounded before publication', async (t) => {
    const s = setup(t);
    const result = await s.turn('AUTH=x\n'.repeat(18000), true);
    assert.equal(result.code, 65, result.stderr);
    assert.equal(fs.existsSync(join(s.repo, '.krn')), false);
  });
});

test('unsafe inbox and temporary-directory ancestors are refused before partial start state', {
  concurrency: 6,
}, async (t) => {
  for (const name of ['inbox', 'tmp']) {
    t.test(name, async (t) => {
      const s = setup(t);
      const outside = join(s.root, 'outside');
      fs.mkdirSync(outside);
      fs.mkdirSync(s.run, { recursive: true });
      fs.symlinkSync(outside, join(s.run, name));
      const result = await s.turn('ok', true);
      assert.equal(result.code, 65, result.stderr);
      assert.deepEqual(fs.readdirSync(s.run), [name]);
      assert.deepEqual(fs.readdirSync(outside), []);
    });
  }
});

test('ignored .krn baseline detects changed, created, deleted and retyped paths outside its run', {
  concurrency: 6,
}, async (t) => {
  for (const action of ['write', 'delete', 'retype', 'relink']) {
    t.test(action, async (t) => {
      const s = setup(t);
      const path = '.krn/runs/other/record';
      fs.mkdirSync(dirname(join(s.repo, path)), { recursive: true });
      if (action === 'relink') fs.symlinkSync('before', join(s.repo, path));
      else fs.writeFileSync(join(s.repo, path), 'before edit');
      const result = await s.turn(`${action} ${path}`, true);
      assert.equal(result.code, 3, result.stderr);
      assert.ok(result.stderr.includes(path), result.stderr);
    });
  }
  t.test('new path after an unchanged turn', async (t) => {
    const s = setup(t);
    fs.mkdirSync(join(s.repo, '.krn/runs/other'), { recursive: true });
    assert.equal((await s.turn('ok', true)).code, 0);
    const result = await s.turn('write .krn/runs/other/new');
    assert.equal(result.code, 3, result.stderr);
  });
});

test('ignored forbidden roots also remain in the baseline', async (t) => {
  const s = setup(t);
  fs.mkdirSync(join(s.repo, '.codex'));
  fs.writeFileSync(join(s.repo, '.codex/config.toml'), 'before edit');
  const result = await s.turn('write .codex/config.toml', true);
  assert.equal(result.code, 3, result.stderr);
});

test('ignored ordinary roots cannot hide baseline instruction files or new symlinks', {
  concurrency: 6,
}, async (t) => {
  for (const action of ['write private/AGENTS.md', 'link private/new-link']) {
    t.test(action, async (t) => {
      const s = setup(t);
      fs.mkdirSync(join(s.repo, 'private'));
      fs.writeFileSync(join(s.repo, 'private/AGENTS.md'), 'before edit');
      const result = await s.turn(action, true);
      assert.equal(result.code, 3, result.stderr);
    });
  }
});

// One owner per baseline bound: the file count is counted under .krn and the
// byte total accumulates across roots, so neither a per-file size check nor an
// uncounted .krn passes.
test('untracked baseline enforces file-count and accumulated content bounds before launching a server', {
  concurrency: 6,
}, async (t) => {
  for (const bound of ['files', 'bytes']) {
    t.test(bound, async (t) => {
      const s = setup(t);
      if (bound === 'files') {
        const outsideRun = join(s.repo, '.krn/other');
        fs.mkdirSync(outsideRun, { recursive: true });
        for (let i = 0; i <= 10000; i++)
          fs.writeFileSync(join(outsideRun, String(i)), 'x');
      } else {
        // Git lists untracked roots sorted, so the 1-byte root is summed
        // first and the exactly-1 GB root crosses the total without being read.
        fs.writeFileSync(join(s.repo, 'a-small'), 'x');
        const large = join(s.repo, 'b-large');
        fs.writeFileSync(large, '');
        fs.truncateSync(large, 1024 * 1024 * 1024);
      }
      const result = await s.turn('ok', true);
      assert.equal(result.code, 65, result.stderr);
      assert.match(result.stderr, bound === 'files' ? /10000/ : /1 GB/);
      assert.equal(fs.existsSync(s.env.CODEX_TEST_WORKER_PID ?? ''), false);
    });
  }
});

test('exactly 10000 .krn files fit the file bound, with the own run excluded', async (t) => {
  const s = setup(t);
  const path = join(s.repo, '.krn/other');
  fs.mkdirSync(path, { recursive: true });
  for (let i = 0; i < 10000; i++) fs.writeFileSync(join(path, String(i)), '');
  const result = await s.turn('ok', true);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await s.turn('write .krn/other/0')).code, 3);
});

test('multiline quoted credential assignments are redacted in persisted reports', async (t) => {
  const s = setup(t);
  fs.writeFileSync(
    s.env.CODEX_TEST_WORKER_REPORT ?? '',
    'AUTH="first-line\r\nsynthetic-second-line"\nmetadata: ok {"API_KEY":"synthetic-json"}',
  );
  const result = await s.turn('report-secrets', true);
  assert.equal(result.code, 0, result.stderr);
  const text = fs.readFileSync(join(s.run, 'rounds/001/report.json'), 'utf8');
  assert.equal(text.includes('synthetic-second-line'), false);
  assert.equal(text.includes('synthetic-json'), false);
  assert.match(text, /\[redacted\]/);
});

test('scope path text is redacted before persistence and CLI output', async (t) => {
  const s = setup(t);
  assert.equal((await s.turn('ok', true)).code, 0);
  fs.writeFileSync(join(s.repo, '.krn/AUTH=synthetic-path'), 'data');
  const result = await s.turn('ok');
  assert.equal(result.code, 3, result.stderr);
  assert.equal(result.stderr.includes('synthetic-path'), false);
  const text = fs.readFileSync(join(s.run, 'rounds/002/result.json'), 'utf8');
  assert.equal(text.includes('synthetic-path'), false);
});

test('persisted protocol identifiers and derived token totals have bounds', {
  concurrency: 6,
}, async (t) => {
  for (const scenario of [
    'long-thread',
    'secret-thread',
    'newline-thread',
    'unsafe-usage',
  ]) {
    t.test(scenario, async (t) => {
      const s = setup(t);
      s.env.CODEX_TEST_WORKER_INPUT = scenario;
      const result = await s.turn('ok', true);
      assert.equal(result.code, 65, result.stderr);
      const saved = JSON.parse(
        fs.readFileSync(join(s.run, 'session.json'), 'utf8'),
      );
      await until(() => !worker().alive(saved.pid));
      const stored = JSON.stringify(snapshot(s.run));
      assert.equal(
        stored.includes(Buffer.from('sk-synthetic-thread').toString('hex')),
        false,
      );
    });
  }
});

test('invalid persisted session fields refuse send without publishing an inbox', {
  concurrency: 6,
}, async (t) => {
  for (const patch of [
    { model: 'Uppercase' },
    { effort: 'extreme' },
    { timeoutMs: 1e300 },
    { allows: Array.from({ length: 101 }, () => '**') },
    { roots: ['/a', '/b', '/c'] },
    { threadId: 'x'.repeat(1025) },
    { pid: 2147483648 },
    { pid: 1 },
    { serverPid: 1 },
    { rounds: 4 },
    { unit: 'other.scope' },
  ]) {
    t.test(Object.keys(patch)[0] ?? 'record', async (t) => {
      const s = setup(t);
      assert.equal((await s.turn('ok', true)).code, 0);
      const path = join(s.run, 'session.json');
      const original = fs.readFileSync(path, 'utf8');
      fs.writeFileSync(
        path,
        JSON.stringify({ ...JSON.parse(original), ...patch }),
      );
      try {
        const result = await s.turn('ok');
        assert.equal(result.code, 65, result.stderr);
        assert.equal(fs.existsSync(join(s.run, 'inbox/002.json')), false);
      } finally {
        fs.writeFileSync(path, original);
      }
    });
  }
});

test('invalid model and effort in an inbox are refused before a turn is forwarded', async (t) => {
  const s = setup(t);
  assert.equal((await s.turn('ok', true)).code, 0);
  const saved = JSON.parse(
    fs.readFileSync(join(s.run, 'session.json'), 'utf8'),
  );
  process.kill(saved.pid, 'SIGSTOP');
  const pending = s.turn('ok');
  try {
    const path = join(s.run, 'inbox/002.json');
    await until(() => fs.existsSync(path));
    fs.writeFileSync(
      path,
      JSON.stringify({ text: 'ok', model: 'Uppercase', effort: 'extreme' }),
    );
  } finally {
    process.kill(saved.pid, 'SIGCONT');
  }
  const result = await pending;
  assert.equal(result.code, 65, result.stderr);
  const calls = fs
    .readFileSync(s.env.CODEX_TEST_WORKER_LOG ?? '', 'utf8')
    .split('\n')
    .slice(0, -1)
    .map((line) => JSON.parse(line));
  assert.equal(calls.filter((call) => call.method === 'turn/start').length, 1);
});

test('driver derives writable roots instead of trusting persisted roots', async (t) => {
  const s = setup(t);
  assert.equal((await s.turn('ok', true)).code, 0);
  assert.equal((await s.command(['stop'])).code, 0);
  const saved = JSON.parse(
    fs.readFileSync(join(s.run, 'closed-session.json'), 'utf8'),
  );
  fs.rmSync(join(s.run, 'rounds'), { recursive: true });
  fs.rmSync(join(s.run, 'stop'));
  fs.writeFileSync(
    join(s.run, 'session.json'),
    JSON.stringify({
      ...saved,
      roots: [s.root],
      rounds: 0,
      threadId: '',
      pid: 0,
      serverPid: 0,
      status: 'running',
    }),
  );
  fs.writeFileSync(
    join(s.run, 'inbox/001.json'),
    JSON.stringify({ text: 'ok', model: 'gpt-6-luna', effort: 'medium' }),
  );
  const child = spawn(
    process.execPath,
    [resolve('src/worker/driver.ts'), s.run],
    { env: s.env, detached: true, stdio: 'ignore' },
  );
  child.unref();
  await until(() => fs.existsSync(join(s.run, 'rounds/001/result.json')));
  const calls = fs
    .readFileSync(s.env.CODEX_TEST_WORKER_LOG ?? '', 'utf8')
    .split('\n')
    .slice(0, -1)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.filter((call) => call.method === 'thread/start').at(-1).params.config
      .sandbox_workspace_write.writable_roots,
    [s.repo, join(s.run, 'tmp')],
  );
  assert.deepEqual(
    calls.filter((call) => call.method === 'turn/start').at(-1).params
      .sandboxPolicy.writableRoots,
    [s.repo, join(s.run, 'tmp')],
  );
});

test('direct driver input validates its repository boundary before acquiring a lock', async (t) => {
  const s = setup(t);
  assert.equal((await s.turn('ok', true)).code, 0);
  assert.equal((await s.command(['stop'])).code, 0);
  const saved = JSON.parse(
    fs.readFileSync(join(s.run, 'closed-session.json'), 'utf8'),
  );
  const outside = join(s.root, 'outside');
  fs.mkdirSync(join(outside, 'tmp'), { recursive: true });
  fs.writeFileSync(
    join(outside, 'session.json'),
    JSON.stringify({
      ...saved,
      run: outside,
      roots: [s.repo, outside],
      rounds: 0,
      threadId: '',
      pid: 0,
      serverPid: 0,
      status: 'running',
    }),
  );
  const before = snapshot(outside);
  const child = spawn(
    process.execPath,
    [resolve('src/worker/driver.ts'), outside],
    { env: s.env, detached: true },
  );
  let stderr = '';
  let finished = false;
  child.stdout.resume();
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const result = new Promise<number | null>((done) =>
    child.once('close', (code) => {
      finished = true;
      done(code);
    }),
  );
  try {
    await until(() => finished || fs.existsSync(join(outside, 'driver.lock')));
    assert.equal(
      finished,
      true,
      'refused driver must exit before writing a lock',
    );
    assert.equal(await result, 64, stderr);
    assert.deepEqual(snapshot(outside), before);
  } finally {
    for (const pid of [
      child.pid,
      JSON.parse(fs.readFileSync(join(outside, 'session.json'), 'utf8'))
        .serverPid,
    ]) {
      if (!pid) continue;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    }
    await result;
  }
});

test('file reads bound the opened descriptor even when the pathname is replaced', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'krn-worker-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'input');
  fs.writeFileSync(path, 'x'.repeat(1025));
  const original = fs.openSync;
  const mutable = { ...fs };
  mutable.openSync = (...args) => {
    const fd = original(...args);
    if (args[0] === path) {
      fs.renameSync(path, join(root, 'opened'));
      fs.writeFileSync(path, 'small');
    }
    return fd;
  };
  // Patch the builtin through its mutable default export, then restore it.
  Object.assign(fs, { openSync: mutable.openSync });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => worker().readText(path, 1024),
      (error) => error instanceof worker().WorkerError && error.exitCode === 65,
    );
  } finally {
    Object.assign(fs, { openSync: original });
    syncBuiltinESMExports();
  }
});

test('atomic records are bounded before creating their parent directory', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'krn-worker-record-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () =>
      worker().atomic(join(root, 'new/record'), {
        text: 'x'.repeat(2 * 1024 * 1024),
      }),
    (error) => error instanceof worker().WorkerError && error.exitCode === 65,
  );
  assert.equal(fs.existsSync(join(root, 'new')), false);
});

test('failed atomic publication removes its own temporary file', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'krn-worker-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'record');
  fs.mkdirSync(path);
  assert.throws(() => worker().atomic(path, { text: 'bounded' }));
  assert.deepEqual(fs.readdirSync(root), ['record']);
});
