import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup } from './acceptance-fixture.ts';

test('7: send reruns stored acceptance checks', async (t) => {
  const s = await setup(t);
  assert.equal(
    (await s.turn('done-clean', true, ['--check', 'exit 0'])).code,
    0,
  );
  const r = await s.turn('done-clean');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(s.json('rounds/002/result.json').acceptance[0].exit_code, 0);
  assert.equal(s.requests().filter((r) => r.kind === 'sandbox').length, 2);
});
test('8: invalid or start-only options refuse before state or spawn', async (t) => {
  for (const args of [
    Array.from({ length: 17 }, () => ['--check', 'exit 0']).flat(),
    ['--observer', '../x'],
    ['--observer', '/abs'],
    ['--check', 'x'.repeat(4097)],
    ['--check', ''],
    ['--observer', 'a/../b'],
  ]) {
    const s = await setup(t);
    const r = await s.turn('done-clean', true, args);
    assert.equal(r.code, 64, r.stderr);
    assert.equal(existsSync(join(s.run, 'session.json')), false);
    assert.equal(existsSync(s.env.CODEX_TEST_WORKER_LOG ?? ''), false);
  }
  const s = await setup(t);
  const r = await s.turn('done-clean', false, ['--check', 'x']);
  assert.equal(r.code, 64, r.stderr);
  assert.equal(existsSync(s.env.CODEX_TEST_WORKER_LOG ?? ''), false);
});
test('9: old sessions default lists and reports refuse canary', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('done-clean', true)).code, 0);
  const module = await import('../../src/worker/state.ts');
  assert.equal(typeof module.sessionSchema.parse, 'function');
  const old = s.json('session.json');
  delete old.checks;
  delete old.observers;
  assert.deepEqual(module.sessionSchema.parse(old).checks, []);
  assert.deepEqual(module.sessionSchema.parse(old).observers, []);
  const report = s.json('rounds/001/report.json');
  assert.equal(module.reportSchema.safeParse(report).success, true);
  assert.equal(
    module.reportSchema.safeParse({ ...report, canary: '' }).success,
    false,
  );
  assert.equal(module.acceptanceValueSchema.safeParse('a\0b').success, false);
  assert.equal(
    module.acceptanceValueSchema.safeParse('ą'.repeat(2049)).success,
    false,
  );
});
test('10: output is capped and redacted', async (t) => {
  const s = await setup(t);
  const r = await s.turn('done-clean', true, [
    '--check',
    'printf "sk-"; printf "synthetic-secret\\n"; head -c 1100000 /dev/zero | tr "\\000" x',
  ]);
  assert.equal(r.code, 0, r.stderr);
  const log = readFileSync(join(s.run, 'rounds/001/acceptance-1.log'), 'utf8');
  assert.doesNotMatch(log, /sk-synthetic-secret/);
  assert.match(log, /\[redacted\]/);
  assert.match(log, /\[truncated at 1048576 bytes\]\n$/);
  assert.ok(Buffer.byteLength(log) <= 1048576);
});
test('11: a private key across the log limit or past the capture is redacted', async (t) => {
  for (const [label, tail] of [
    [
      'straddling',
      'printf "MIIEsecretbody\\n-----END RSA PRIV""ATE KEY-----\\n"',
    ],
    ['unterminated', 'head -c 2200000 /dev/zero | tr "\\000" y'],
  ]) {
    const s = await setup(t);
    const r = await s.turn('done-clean', true, [
      '--check',
      `head -c 1048500 /dev/zero | tr "\\000" x; printf "\\n-----BEGIN RSA PRIV""ATE KEY-----\\nMIIEsecretbody\\n"; ${tail}`,
    ]);
    assert.equal(r.code, 0, `${label}: ${r.stderr}`);
    const log = readFileSync(
      join(s.run, 'rounds/001/acceptance-1.log'),
      'utf8',
    );
    assert.doesNotMatch(log, /BEGIN RSA PRIVATE KEY|MIIEsecretbody/, label);
    assert.ok(Buffer.byteLength(log) <= 1048576, label);
  }
});
test('12: a credential-like check or observer is refused, never stored altered', async (t) => {
  for (const args of [
    ['--check', 'printf sk-example'],
    ['--observer', 'sk-example.test.mjs'],
  ]) {
    const s = await setup(t);
    const r = await s.turn('done-clean', true, args);
    assert.equal(r.code, 64, r.stderr);
    assert.match(r.stderr, /looks like a credential/);
    assert.equal(existsSync(join(s.run, 'session.json')), false);
  }
});
