import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { alive, setup, until } from './state-trust-fixture.ts';

test('a turn cannot change driver files, including the session state, but can use tmp', async (t) => {
  for (const path of [
    'session.json',
    'driver.lock',
    'inbox/forged.json',
    'rounds/001/metrics.json',
    'summary.json',
    'tmp/ok',
  ]) {
    await t.test(path, async (t) => {
      const s = setup(t);
      const result = await s.turn(
        `write ${relative(s.repo, join(s.run, path))}`,
        true,
      );
      assert.equal(result.code, path.startsWith('tmp/') ? 0 : 3, result.stderr);
      if (!path.startsWith('tmp/'))
        assert.match(result.stderr, /scope violation|integrity/);
    });
  }
});
test('tmp symlinks are refused before launching a server', async (t) => {
  const s = setup(t);
  mkdirSync(s.run, { recursive: true });
  symlinkSync(s.root, join(s.run, 'tmp'));
  const result = await s.turn('ok', true);
  assert.equal(result.code, 65, result.stderr);
  assert.equal(s.rows().length, 0);
});
test('state integrity is checked against driver memory before accepting another turn', async (t) => {
  const s = setup(t);
  assert.equal((await s.turn('ok', true)).code, 0);
  const saved = s.state();
  writeFileSync(
    join(s.run, 'session.json'),
    JSON.stringify({ ...saved, serverStartTime: '1' }),
  );
  const result = await s.turn('ok');
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stderr, /integrity/);
  await until(() => !alive(saved.pid) && !alive(saved.serverPid));
  assert.equal(s.rows().filter((r) => r.method === 'turn/start').length, 1);
  assert.equal(s.state().serverStartTime, saved.serverStartTime);
});
test('a turn cannot replace the tmp root with a symlink or create a stop request', async (t) => {
  for (const action of [
    'relink .krn/runs/worker/tmp',
    'write .krn/runs/worker/stop',
  ]) {
    await t.test(action, async (t) => {
      const s = setup(t);
      const result = await s.turn(action, true);
      assert.equal(result.code, 3, result.stderr);
    });
  }
});
test('proc stat parsing uses the last parenthesis for comm names with spaces and parentheses', async () => {
  const module = await import('../../src/worker/process.ts').catch(
    () => undefined,
  );
  assert.equal(
    typeof module?.parseProcessStat,
    'function',
    'worker process parser is missing',
  );
  assert.ok(module);
  assert.deepEqual(
    module.parseProcessStat(
      `42 (worker ) with spaces) S 1 42 ${Array(16).fill('0').join(' ')} 987654 0`,
    ),
    { state: 'S', group: 42, startTime: '987654' },
  );
});
