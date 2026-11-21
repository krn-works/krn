import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { taskMerge } from '../../src/ci/task-merge.ts';
import { ticketCommitTitle } from '../../src/cli/lane-run/delivery.ts';
import { parseTickets } from '../../src/repo/protocol-lines.ts';
import { branchTicketFindings } from '../../src/task/branch-tickets.ts';

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

test('a ticket outside the trailer block is not a ticket', () => {
  assert.deepEqual(
    parseTickets('fix: y\n\nTicket: t-abc1234\n\nprose after it\n'),
    [],
  );
});

test('a space before the colon still names the key, as git reads it', () => {
  assert.deepEqual(
    parseTickets('fix: y\n\nTicket : t-abc1234\nRefs: t-1kn5yb8'),
    [
      { key: 'Ticket', ids: ['t-abc1234'] },
      { key: 'Refs', ids: ['t-1kn5yb8'] },
    ],
  );
});

test('a fenced Ticket example is no trailer', () => {
  assert.deepEqual(
    parseTickets('docs: x\n\nExample:\n\n```text\nTicket: t-abc1234\n```'),
    [],
  );
});

test('a Refs footer below a Ticket paragraph keeps both', () => {
  assert.deepEqual(
    parseTickets('fix: y\n\nTicket: t-abc1234\n\nRefs: t-1kn5yb8'),
    [
      { key: 'Ticket', ids: ['t-abc1234'] },
      { key: 'Refs', ids: ['t-1kn5yb8'] },
    ],
  );
});

function withCommit(message: string, check: (repo: string) => void): void {
  const repo = mkdtempSync(join(tmpdir(), 'krn-ticket-lines-'));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@example.test',
        '-c',
        'commit.gpgSign=false',
        ...args,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  try {
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'Base');
    git('commit', '-q', '--allow-empty', '-m', message);
    check(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test('branch check ignores a fenced Ticket example in a commit body', () => {
  withCommit(
    'docs: explain\n\nExample:\n\n```text\nTicket: t-abc1234\n```',
    (repo) => {
      assert.deepEqual(
        branchTicketFindings(repo, new Map(), 'HEAD^', 'HEAD'),
        [],
      );
    },
  );
});

test('branch check reads a Ticket trailer with a space before its colon', () => {
  withCommit('fix: update\n\nTicket : t-abc1234\nRefs: t-1kn5yb8', (repo) => {
    const short = execFileSync(
      'git',
      ['-C', repo, 'rev-parse', '--short', 'HEAD'],
      {
        encoding: 'utf8',
      },
    ).trim();
    assert.deepEqual(branchTicketFindings(repo, new Map(), 'HEAD^', 'HEAD'), [
      `Ticket: t-abc1234 (${short}) names no task`,
    ]);
  });
});

test('a PR body of only an indented Ticket example does not attribute a merge', () => {
  const listed = JSON.stringify([
    {
      number: 12,
      title: 'docs: show task metadata',
      body: '    Ticket: t-abc1234\r\n',
      mergeCommit: { oid: 'abc' },
    },
  ]);
  assert.equal(
    taskMerge(listed, 't-abc1234', (sha) => sha === 'abc'),
    undefined,
  );
});

test('an unrelated Refs footer keeps the delivery title of a Ticket in the body', () => {
  const log =
    'fix: update delivery\x1fTicket: t-abc1234\n\nRefs: t-1kn5yb8\n\x1e';
  assert.equal(
    ticketCommitTitle(log, 't-abc1234'),
    'fix: update delivery (t-abc1234)',
  );
});
