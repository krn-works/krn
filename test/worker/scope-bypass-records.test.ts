import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { setup, until } from './scope-bypass-fixture.ts';

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
test('git-ignored .krn/tmp scratch writes are not scope changes while symlinks there still are', async (t) => {
  const s = await setup(t);
  mkdirSync(join(s.repo, '.krn/tmp/node-compile-cache/old'), {
    recursive: true,
  });
  writeFileSync(join(s.repo, '.krn/tmp/node-compile-cache/old/entry'), 'old');
  const written = await s.turn('write .krn/tmp/node-compile-cache/v24/entry')
    .result;
  assert.equal(written.code, 0, written.stderr);
  assert.ok(!written.stderr.includes('.krn/tmp'), written.stderr);
  const linked = await s.turn('link .krn/tmp/escape').result;
  assert.equal(linked.code, 3, linked.stderr);
  assert.ok(linked.stderr.includes('.krn/tmp/escape'), linked.stderr);
});
