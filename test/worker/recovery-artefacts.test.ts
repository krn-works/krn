import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { alive, setup, until } from './recovery-fixture.ts';

test('start refuses every prior session artefact by name before spawning a driver', async (t) => {
  for (const artefact of [
    'error.json',
    'rounds',
    'closed-session.json',
    'inbox',
    'stop',
    'summary.json',
    'driver.lock',
  ]) {
    for (const shape of ['valid', 'malformed']) {
      await t.test(`${artefact} ${shape}`, async (t) => {
        const s = await setup(t);
        mkdirSync(s.run, { recursive: true });
        const path = join(s.run, artefact);
        if (artefact === 'rounds' || artefact === 'inbox') {
          mkdirSync(path);
          if (shape === 'malformed') {
            const directory = join(path, '002');
            mkdirSync(directory);
            writeFileSync(join(directory, 'result.json'), '{');
          }
        } else
          writeFileSync(
            path,
            shape === 'malformed'
              ? '{'
              : JSON.stringify({ exit_code: 91, message: 'earlier session' }),
          );
        const result = await s.turn('ok', true).result;
        assert.equal(result.code, 75, result.stderr);
        assert.ok(result.stderr.includes(artefact), result.stderr);
        assert.equal(
          existsSync(join(s.run, 'session.json')),
          false,
          'refused start spawned a driver',
        );
        assert.equal(existsSync(s.env.CODEX_TEST_WORKER_PID), false);
        assert.deepEqual(s.rows(), []);
      });
    }
  }
});

test('restart after an initialization error and stop refuses the old error without a new driver', async (t) => {
  const s = await setup(t);
  s.env.CODEX_TEST_WORKER_VERSION = '0.0.0';
  assert.equal((await s.turn('ok', true).result).code, 65);
  await until(
    () => existsSync(join(s.run, 'summary.json')) && !alive(s.state().pid),
  );
  assert.equal((await s.launch('stop').result).code, 0);
  const before = s.rows();
  s.env.CODEX_TEST_WORKER_VERSION = '0.166.0';
  const result = await s.turn('ok', true).result;
  assert.equal(result.code, 75, result.stderr);
  assert.match(result.stderr, /error\.json/);
  assert.equal(existsSync(join(s.run, 'session.json')), false);
  assert.deepEqual(s.rows(), before);
});

test('send and stop never consume closed-session results or errors', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('ok', true).result).code, 0);
  assert.equal((await s.launch('stop').result).code, 0);
  writeFileSync(join(s.run, 'error.json'), '{');
  const before = s.rows();
  const sent = await s.turn('ok').result;
  assert.equal(sent.code, 65, sent.stderr);
  assert.match(sent.stderr, /session\.json/);
  assert.equal((await s.launch('stop').result).code, 0);
  assert.deepEqual(s.rows(), before);
});
