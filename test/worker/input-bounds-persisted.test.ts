import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setup, until } from './input-bounds-fixture.ts';

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
