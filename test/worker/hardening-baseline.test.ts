import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { alive, setup, until } from './hardening-fixture.ts';

test('pre-existing index flags are baseline data and read-only Git checks preserve the index', async (t) => {
  const s = await setup(t);
  s.git('update-index', '--assume-unchanged', 'README.md');
  s.git('update-index', '--skip-worktree', 'spec/worker-scope.json');
  assert.equal((await s.turn('ok', true).result).code, 0);
  assert.equal((await s.turn('ok').result).code, 0);
});
test('untracked baseline compares content, deletions, types and symlink targets through the tiers', {
  concurrency: 6,
}, async (t) => {
  for (const action of ['write', 'delete', 'retype', 'relink']) {
    t.test(action, async (t) => {
      const s = await setup(t);
      const path = join(s.repo, 'AGENTS.md');
      if (action === 'relink') symlinkSync('initial-target', path);
      else writeFileSync(path, 'before edit'); // Same size as "worker edit".
      const result = await s.turn(`${action} AGENTS.md`, true).result;
      assert.equal(result.code, 3, result.stderr);
      assert.ok(result.stderr.includes('AGENTS.md'), result.stderr);
    });
  }
  t.test('review tier and unchanged symlink', async (t) => {
    const s = await setup(t);
    mkdirSync(join(s.repo, 'docs'));
    writeFileSync(join(s.repo, 'docs/guide.md'), 'before edit');
    symlinkSync('old-target', join(s.repo, 'existing-link'));
    assert.equal((await s.turn('ok', true).result).code, 0);
    const result = await s.turn('write docs/guide.md').result;
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(s.json('rounds/002/result.json').needs_lead_note, [
      'docs/guide.md',
    ]);
  });
});
test('missing, mismatched and malformed usage fail closed, interrupt, stop scope and never persist zero metrics', {
  concurrency: 6,
}, async (t) => {
  for (const action of [
    'no-usage',
    'wrong-thread-usage',
    'wrong-turn-usage',
    'bad-usage',
  ]) {
    t.test(action, async (t) => {
      const s = await setup(t);
      // Missing usage on a later turn must not reuse the preceding metrics.
      assert.equal((await s.turn('ok', true).result).code, 0);
      const state = s.json('session.json');
      const result = await s.turn(action).result;
      assert.equal(result.code, 65, result.stderr);
      assert.match(result.stderr, /usage/);
      assert.equal(existsSync(join(s.run, 'rounds/002/metrics.json')), false);
      await until(() =>
        s.requests().some((row) => row.method === 'turn/interrupt'),
      );
      await until(() => !alive(state.pid) && !alive(state.serverPid));
      assert.ok(
        s
          .rows(s.env.CODEX_TEST_WORKER_SCOPE_LOG)
          .some((row) => JSON.stringify(row).includes(state.unit)),
      );
      assert.equal((await s.turn('ok').result).code, 5);
    });
  }
  t.test(
    'first turn has no fabricated metrics or summary tokens',
    async (t) => {
      const s = await setup(t);
      const result = await s.turn('no-usage', true).result;
      assert.equal(result.code, 65, result.stderr);
      await until(() => existsSync(join(s.run, 'summary.json')));
      assert.equal(existsSync(join(s.run, 'rounds/001/metrics.json')), false);
      assert.equal('tokens' in s.json('summary.json'), false);
    },
  );
});
test('start and stop reap the recorded server scope and process group after driver SIGKILL', {
  concurrency: 6,
}, async (t) => {
  for (const command of ['start', 'stop']) {
    t.test(command, async (t) => {
      const s = await setup(t);
      const pending = s.turn('hang-orphan', true);
      await until(
        () =>
          pending.finished ||
          s.requests().some((row) => row.method === 'turn/start'),
      );
      assert.ok(
        s.requests().some((row) => row.method === 'turn/start'),
        'server did not start a turn',
      );
      const state = s.json('session.json');
      assert.match(state.unit, /^krn-worker-.+\.scope$/);
      assert.equal(alive(state.serverPid), true);
      process.kill(state.pid, 'SIGKILL');
      assert.equal((await pending.result).code, 75);
      await until(() => !alive(state.pid));
      assert.equal(
        alive(state.serverPid),
        true,
        'fixture must leave a live orphan for the reaper',
      );
      const result =
        command === 'start'
          ? await s.turn('ok', true).result
          : await s.launch(['stop']).result;
      assert.equal(result.code, command === 'start' ? 75 : 0, result.stderr);
      assert.equal(
        alive(state.serverPid),
        false,
        'recorded orphan server remains alive',
      );
      assert.ok(
        s
          .rows(s.env.CODEX_TEST_WORKER_SCOPE_LOG)
          .some(
            (row) =>
              JSON.stringify(row) ===
              JSON.stringify(['--user', 'stop', state.unit]),
          ),
      );
    });
  }
});
