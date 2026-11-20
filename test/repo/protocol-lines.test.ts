import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTickets } from '../../src/repo/protocol-lines.ts';

test('a single Ticket trailer returns its one id', () => {
  assert.deepEqual(
    parseTickets('feat(x): y (t-abc1234)\n\nTicket: t-abc1234\n'),
    [{ key: 'Ticket', ids: ['t-abc1234'] }],
  );
});

test('a comma list returns every id under its key', () => {
  assert.deepEqual(parseTickets('fix: y\n\nRefs: t-w2bsagz, t-1kn5yb8\n'), [
    { key: 'Refs', ids: ['t-w2bsagz', 't-1kn5yb8'] },
  ]);
});

test('a Ticket paragraph above a Co-Authored-By paragraph is read', () => {
  assert.deepEqual(
    parseTickets(
      'fix: y\n\nbody text\n\nTicket: t-abc1234\n\nCo-Authored-By: A <a@b.c>\n',
    ),
    [{ key: 'Ticket', ids: ['t-abc1234'] }],
  );
});

test('a Ticket line outside the trailer block is found by the fallback', () => {
  assert.deepEqual(
    parseTickets('fix: y\n\nTicket: t-abc1234\nprose after it\n'),
    [{ key: 'Ticket', ids: ['t-abc1234'] }],
  );
});

test('a pull request body with only a Refs line and CRLF endings is read', () => {
  assert.deepEqual(parseTickets('## Task\r\n\r\nRefs: t-abc1234\r\n'), [
    { key: 'Refs', ids: ['t-abc1234'] },
  ]);
});

test('a message without the lines returns nothing', () => {
  assert.deepEqual(parseTickets('fix: y\n\nCo-Authored-By: A <a@b.c>\n'), []);
});

test('the key matches case-insensitively like git trailers', () => {
  assert.deepEqual(parseTickets('fix: y\n\nticket: t-abc1234, t-1kn5yb8\n'), [
    { key: 'Ticket', ids: ['t-abc1234', 't-1kn5yb8'] },
  ]);
});

test('a Refs list folded onto a continuation line is read', () => {
  assert.deepEqual(parseTickets('fix: y\n\nRefs: t-abc1234,\n  t-1kn5yb8\n'), [
    { key: 'Refs', ids: ['t-abc1234', 't-1kn5yb8'] },
  ]);
});

test('an indented Ticket example in prose is no trailer', () => {
  assert.deepEqual(
    parseTickets('fix: y\n\nUse it like this:\n\n    Ticket: t-abc1234\n'),
    [],
  );
  assert.deepEqual(parseTickets('## Why\n\n  Refs: t-abc1234\n\nmore\n'), []);
});
