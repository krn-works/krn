import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup } from './hardening-fixture.ts';

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
