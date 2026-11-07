import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { credentials, setup, until } from './hardening-fixture.ts';

test('PEM, AWS and credential assignments are redacted in start and send inboxes and persisted report text', async (t) => {
  const s = await setup(t);
  const release = join(s.root, 'initialize-release');
  s.env.CODEX_TEST_WORKER_INITIALIZE_GATE = release;
  const text = credentials.map(([source]) => source).join('\r\n');
  const inspect = (path: string) => {
    const stored = readFileSync(path, 'utf8');
    for (const [, secret] of credentials)
      assert.equal(stored.includes(secret), false, secret);
    assert.match(stored, /\[redacted\]/);
    assert.equal(stored.includes('synthetic-passwd'), false);
    assert.equal(stored.includes('synthetic-api-key'), false);
    assert.equal(stored.includes('synthetic-password'), false);
  };
  const first = s.turn(text, true);
  try {
    await until(
      () => first.finished || existsSync(join(s.run, 'inbox/001.json')),
    );
    assert.ok(
      existsSync(join(s.run, 'inbox/001.json')),
      'start did not publish an inbox record',
    );
    inspect(join(s.run, 'inbox/001.json'));
  } finally {
    writeFileSync(release, 'release');
    await first.result;
  }
  assert.equal((await first.result).code, 0);
  const state = s.json('session.json');
  process.kill(state.pid, 'SIGSTOP');
  const second = s.turn(text);
  try {
    await until(
      () => second.finished || existsSync(join(s.run, 'inbox/002.json')),
    );
    assert.ok(
      existsSync(join(s.run, 'inbox/002.json')),
      'send did not publish an inbox record',
    );
    inspect(join(s.run, 'inbox/002.json'));
  } finally {
    process.kill(state.pid, 'SIGCONT');
    await second.result;
  }
  assert.equal((await second.result).code, 0);
  writeFileSync(s.env.CODEX_TEST_WORKER_REPORT, text);
  const before = readFileSync(join(s.run, 'session.json'), 'utf8');
  const third = await s.turn('report-secrets', false, s.run, [
    '--model',
    'AUTH=synthetic-model',
    '--effort',
    'TOKEN: synthetic-effort',
  ]).result;
  assert.equal(third.code, 64, third.stderr);
  assert.equal(readFileSync(join(s.run, 'session.json'), 'utf8'), before);
  assert.equal(existsSync(join(s.run, 'inbox/003.json')), false);
  assert.equal(existsSync(join(s.run, 'rounds/003')), false);
  assert.equal((await s.turn('report-secrets').result).code, 0);
  inspect(join(s.run, 'rounds/003/report.json'));
});
test('start refuses an --allow value that names a forbidden path before spawning', {
  concurrency: 6,
}, async (t) => {
  for (const value of [
    '.agents/skills/x/SKILL.md',
    'tasks/a.json',
    '.git/config',
    'docs/program/lead-rules.md',
  ]) {
    t.test(value, async (t) => {
      const s = await setup(t);
      const result = await s.turn('ok', true, s.run, ['--allow', value]).result;
      assert.equal(result.code, 64, result.stderr);
      assert.match(result.stderr, /names a forbidden path/);
      assert.ok(result.stderr.includes(value), result.stderr);
      assert.equal(existsSync(s.env.CODEX_TEST_WORKER_PID), false);
      assert.equal(existsSync(join(s.run, 'session.json')), false);
      assert.equal(existsSync(s.env.CODEX_TEST_WORKER_LOG), false);
    });
  }
  // A wildcard allow that overlaps forbidden globs is accepted on purpose:
  // `src/**` and `docs/**` overlap `**/AGENTS.md` and `docs/adr/**`, and the
  // scope check still fails any forbidden change under it (exit 3).
  t.test('wildcard allow still fails a forbidden change', async (t) => {
    const s = await setup(t);
    const result = await s.turn(
      'write .agents/skills/x/SKILL.md',
      true,
      s.run,
      ['--allow', '**'],
    ).result;
    assert.equal(result.code, 3, result.stderr);
    assert.match(
      result.stderr,
      /scope violation: .*\.agents\/skills\/x\/SKILL\.md/,
    );
  });
  for (const value of ['src/**', 'docs/**', 'test/worker/x.test.ts']) {
    t.test(`accepts ${value}`, async (t) => {
      const s = await setup(t);
      const result = await s.turn('ok', true, s.run, ['--allow', value]).result;
      assert.equal(result.code, 0, result.stderr);
    });
  }
});
test('worker developer instructions stay within the byte budget', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('ok', true).result).code, 0);
  const thread = s.requests().find((row) => row.method === 'thread/start');
  const text = thread?.params?.developerInstructions ?? '';
  assert.ok(Buffer.byteLength(text) <= 600);
});
