import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup } from './required-outputs-fixture.ts';

test('required output missing refuses done', async (t) => {
  const s = await setup(t);
  const r = await s.turn('done-without-writing', true, ['--require', 'a.txt']);
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /missing required output a.txt/);
  const send = await s.turn('ok');
  assert.equal(send.code, 4, send.stderr);
  assert.match(send.stderr, /missing required output a.txt/);
});
test('old session defaults required paths', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('ok', true)).code, 0);
  const { sessionSchema } = await import('../../src/worker/state.ts');
  const old = s.json('session.json');
  delete old.requires;
  assert.deepEqual(sessionSchema.parse(old).requires, []);
});

test('required output written succeeds cumulatively', async (t) => {
  const s = await setup(t);
  assert.equal(
    (await s.turn('write a.txt', true, ['--require', 'a.txt'])).code,
    0,
  );
  assert.equal((await s.turn('ok')).code, 0);
});
test('deletion does not satisfy required output', async (t) => {
  const s = await setup(t);
  writeFileSync(join(s.repo, 'a.txt'), 'base');
  for (const args of [
    ['add', '.'],
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'file',
    ],
  ])
    assert.equal(spawnSync('git', ['-C', s.repo, ...args]).status, 0);
  const r = await s.turn('delete a.txt', true, ['--require', 'a.txt']);
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /missing required output a.txt/);
});
