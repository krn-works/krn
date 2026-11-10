import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// KRN-12: runs the real `krn decide` entry against a temporary root.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function krn(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, 'decide', ...args, '--root', root], {
    encoding: 'utf8',
  });
}

test('a decision is listed with its deadline and close records who decided', () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-decide-'));
  const added = krn(
    root,
    'add',
    '--question',
    'Ship the cache?',
    '--recommendation',
    'yes',
    '--default',
    'ship',
    '--deadline',
    '2099-01-02',
  );
  assert.equal(added.status, 0, added.stderr);
  const id = added.stdout.trim();
  assert.match(id, /^d-[0-9a-f]{6}$/u);
  assert.equal(readdirSync(join(root, '.krn', 'operator')).length, 1);

  const listed = krn(root, 'list');
  assert.match(listed.stdout, new RegExp(`${id}  deadline 2099-01-02  open`));
  assert.match(listed.stdout, /recommendation: yes/u);
  assert.match(listed.stdout, /default: ship/u);

  const notified = krn(root, 'list', '--notify');
  assert.match(notified.stdout, new RegExp(id));
  assert.equal(krn(root, 'list', '--notify').stdout, '');

  const closed = krn(root, 'close', id, '--by', 'operator', '--decision', 'no');
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(krn(root, 'list').stdout, '');
  assert.match(krn(root, 'list', '--all').stdout, /closed by operator: no/u);
  assert.equal(
    krn(root, 'close', id, '--by', 'x', '--decision', 'y').status,
    64,
  );
});

test('a bad deadline and an unknown id exit 64', () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-decide-'));
  const bad = krn(
    root,
    'add',
    '--question',
    'q',
    '--recommendation',
    'r',
    '--default',
    'd',
    '--deadline',
    'soon',
  );
  assert.equal(bad.status, 64);
  assert.equal(
    krn(root, 'close', 'd-000000', '--by', 'a', '--decision', 'b').status,
    64,
  );
});
