import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  type Probe,
  serveElapsedSeconds,
  unattendedReport,
} from '../../src/cli/doctor-unattended.ts';

const capture = (name: string) =>
  readFileSync(
    new URL(`../fixtures/bw-serve/${name}`, import.meta.url),
    'utf8',
  );
const secret = 'ghs_SECRETTOKENVALUE';

function stub(options: { mint?: number; etimes?: number | null }): Probe {
  return (command, args) => {
    if (command === 'ss') {
      assert.deepEqual(args, ['-H', '-ltnp', 'sport = :8087']);
      return options.etimes === null
        ? { status: 0, stdout: '', stderr: '' }
        : { status: 0, stdout: capture('ss-listen.txt'), stderr: '' };
    }
    if (command === 'ps') {
      assert.deepEqual(args, ['-o', 'etimes=', '-p', '3650474']);
      return { status: 0, stdout: `  ${options.etimes}\n`, stderr: '' };
    }
    return options.mint === 0 || options.mint === undefined
      ? { status: 0, stdout: `${secret}\n`, stderr: '' }
      : { status: 69, stdout: '', stderr: 'bw serve unavailable\nmore' };
  };
}

test('the captured ps output parses as whole seconds', () => {
  assert.equal(
    serveElapsedSeconds(
      (command) =>
        command === 'ss'
          ? { status: 0, stdout: capture('ss-listen.txt'), stderr: '' }
          : { status: 0, stdout: capture('ps-etimes.txt'), stderr: '' },
      {},
    ),
    9374,
  );
});

test('passes when the token mints and the session outlives the window, without printing the token', () => {
  const report = unattendedReport(
    ['--unattended', '--window-hours', '6'],
    {},
    stub({ etimes: 3600 }),
  );
  assert.equal(report.exitCode, 0);
  assert.match(report.text, /^PASS unattended/u);
  assert.ok(!report.text.includes(secret));
});

test('exits 69 naming bw-up when the mint fails', () => {
  const report = unattendedReport(
    ['--unattended'],
    {},
    stub({ mint: 1, etimes: 10 }),
  );
  assert.equal(report.exitCode, 69);
  assert.match(report.text, /bw serve unavailable.*bw-up/u);
});

test('exits 75 with the remedy when the session ends inside the window', () => {
  const report = unattendedReport(
    ['--unattended', '--window-hours', '8'],
    {},
    stub({ etimes: 3 * 3600 }),
  );
  assert.equal(report.exitCode, 75);
  assert.match(report.text, /7\.0h left.*needs 8h.*bw-up/u);
});

test('exits 75 when no bw serve process shows the session age', () => {
  const report = unattendedReport(['--unattended'], {}, stub({ etimes: null }));
  assert.equal(report.exitCode, 75);
});

test('exits 64 on a bad window', () => {
  assert.equal(
    unattendedReport(['--unattended', '--window-hours', 'x'], {}, stub({}))
      .exitCode,
    64,
  );
});
