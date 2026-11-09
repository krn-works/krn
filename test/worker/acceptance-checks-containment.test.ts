import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup } from './acceptance-fixture.ts';

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
test('6: added and removed changed paths both cause drift and preserve failure reasons', {
  concurrency: 6,
}, async (t) => {
  for (const [action, cmd] of [
    ['done-clean', 'echo edit > new.txt; exit 2'],
    ['write a.txt', 'rm a.txt'],
  ] as const) {
    t.test(action, async (t) => {
      const s = await setup(t);
      const r = await s.turn(action, true, ['--check', cmd]);
      assert.equal(r.code, 4, r.stderr);
      assert.match(r.stderr, /acceptance check modified the worktree/);
      if (cmd.includes('exit 2')) assert.match(r.stderr, /acceptance failed/);
    });
  }
});
