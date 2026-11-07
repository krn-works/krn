import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { doneReport, setup } from './report-consistency-fixture.ts';

test('done with a failed check is refused and printed', async (t) => {
  const s = await setup(t);
  const r = await s.turn('done-failing', true);
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /report done with failing check/);
  assert.match(r.stderr, /failing check: npm test exit 1/);
});
test('reasons are bounded per category, sanitized and redacted', async (t) => {
  const s = await setup(t);
  const paths = Array.from(
    { length: 23 },
    (_, i) => `${i}-${'ą'.repeat(600)}\nsecret sk-synthetic-secret`,
  );
  writeFileSync(
    s.env.CODEX_TEST_WORKER_REPORT ?? '',
    JSON.stringify({
      status: 'done',
      summary: '',
      changed_paths: paths,
      checks: Array.from({ length: 23 }, () => ({
        cmd: `cmd\n${'ą'.repeat(600)}`,
        exit_code: 1,
        note: '',
      })),
      findings: [],
      unverified: [],
      blockers: [],
    }),
  );
  const r = await s.turn('custom-report', true);
  assert.equal(r.code, 4, r.stderr);
  const message = s.json('rounds/001/result.json').message;
  assert.doesNotMatch(message, /[\r\n]|sk-synthetic-secret/);
  assert.equal(
    message.split('; ').filter((part: string) => part === '… 3 more').length,
    2,
  );
  assert.equal(message.split('report names unchanged path ').length - 1, 20);
  assert.match(message, /…/);
});
test('a file in a new directory is not an omitted directory', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('write newdir/deep/file.txt', true)).code, 0);
  writeFileSync(
    s.env.CODEX_TEST_WORKER_REPORT ?? '',
    doneReport(['newdir/deep/file.txt']),
  );
  const r = await s.turn('custom-report');
  assert.equal(r.code, 0, r.stderr);
});
test('a backslash is an ordinary file name character', async (t) => {
  const s = await setup(t);
  const first = await s.turn('write a\\b.txt', true, ['--require', 'a\\b.txt']);
  assert.equal(first.code, 0, first.stderr);
  writeFileSync(s.env.CODEX_TEST_WORKER_REPORT ?? '', doneReport(['a\\b.txt']));
  const r = await s.turn('custom-report');
  assert.equal(r.code, 0, r.stderr);
});
test('each formatted reason including its prefix fits 512 bytes', async (t) => {
  const s = await setup(t);
  const long = `${'x'.repeat(600)}.txt`;
  writeFileSync(s.env.CODEX_TEST_WORKER_REPORT ?? '', doneReport([]));
  const r = await s.turn('custom-report', true, ['--require', long]);
  assert.equal(r.code, 4, r.stderr);
  const message = s.json('rounds/001/result.json').message as string;
  assert.match(message, /missing required output x/);
  for (const part of message.split('; '))
    assert.ok(Buffer.byteLength(part) <= 512, `${Buffer.byteLength(part)}`);
});
