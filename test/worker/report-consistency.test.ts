import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup } from './report-consistency-fixture.ts';

test('report cannot name an unchanged path', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('write a.txt', true)).code, 0);
  const r = await s.turn('lie-path');
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /report names unchanged path b.txt/);
  assert.match(r.stderr, /report omits changed path a.txt/);
});
test('report must include cumulative changes', async (t) => {
  const s = await setup(t);
  assert.equal((await s.turn('write a.txt', true)).code, 0);
  const r = await s.turn('omit-path');
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /report omits changed path a.txt/);
});
test('report normalizes paths and refuses invalid paths', async (t) => {
  for (const kind of ['dot', 'absolute', 'outside', 'control']) {
    const s = await setup(t);
    assert.equal((await s.turn('write a.txt', true)).code, 0);
    const path =
      kind === 'dot'
        ? './a.txt'
        : kind === 'absolute'
          ? join(s.repo, 'a.txt')
          : kind === 'outside'
            ? '../outside'
            : 'bad\npath';
    writeFileSync(
      s.env.CODEX_TEST_WORKER_REPORT ?? '',
      JSON.stringify({
        status: 'done',
        summary: '',
        changed_paths: [path],
        checks: [],
        findings: [],
        unverified: [],
        blockers: [],
      }),
    );
    const r = await s.turn('custom-report');
    assert.equal(r.code, ['dot', 'absolute'].includes(kind) ? 0 : 4, r.stderr);
  }
});
