import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Dynamic URL keeps the absent base implementation an assertion failure.
const script = new URL('../../scripts/head-trailers.mjs', import.meta.url);
const api = await import(script.href).catch(() => undefined);

test('preflight rejects split, missing and duplicate head trailers', () => {
  assert.equal(typeof api?.checkHeadTrailers, 'function');
  assert.ok(api);
  const valid =
    'feat: change\n\nTicket: t-abc\nChange-contract: test/rules/head-trailers.test.ts:red->green\nCo-Authored-By: A <a@example.com>\n';
  assert.equal(api.checkHeadTrailers(valid).length, 3);
  for (const message of [
    'feat: change\n',
    valid.replace('Ticket: t-abc\n', 'Ticket: t-abc\nTicket: t-def\n'),
    valid.replace('Ticket: t-abc\n', 'Ticket: t-abc\n\n'),
    valid.replace('Change-contract:', '\nChange-contract:'),
    valid.replace('Ticket: t-abc', 'Ticket: '),
    valid.replace('Ticket: t-abc', 'Ticket: t-abc extra'),
  ])
    assert.throws(() => api.checkHeadTrailers(message), /Ticket/u);
});

test('preflight includes rule observers and the head trailer guard', () => {
  const pkg = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../package.json', import.meta.url)),
      'utf8',
    ),
  );
  assert.match(pkg.scripts.preflight, /node scripts\/head-trailers\.mjs/u);
  assert.match(pkg.scripts.preflight, /test\/rules\/\*\.test\.ts/u);
});
