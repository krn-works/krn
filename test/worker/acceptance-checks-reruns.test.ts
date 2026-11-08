import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
