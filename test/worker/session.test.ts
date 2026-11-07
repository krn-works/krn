import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup } from './session-fixture.ts';

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
