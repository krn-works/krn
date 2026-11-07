import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { setup } from './report-outcome-fixture.ts';

test('rollout path is bounded, absolute, redacted and present each round', {
  concurrency: 6,
}, async (t) => {
  for (const path of [
    '/tmp/rollout.jsonl',
    'relative',
    null,
    `/${'ą'.repeat(2048)}`,
    '/tmp/sk-synthetic-secret',
  ]) {
    t.test(String(path)?.slice(0, 40) ?? 'null', async (t) => {
      const s = await setup(t);
      s.env.CODEX_TEST_WORKER_THREAD_PATH = JSON.stringify(path);
      for (const [round, first] of [
        ['001', true],
        ['002', false],
      ] as const) {
        assert.equal((await s.turn('ok', first)).code, 0);
        assert.equal(
          s.json(`rounds/${round}/result.json`).rollout_path,
          path === '/tmp/rollout.jsonl'
            ? path
            : path === '/tmp/sk-synthetic-secret'
              ? '/tmp/[redacted]'
              : null,
        );
      }
    });
  }
});
test('report text is redacted, single line and bounded', async (t) => {
  const s = await setup(t);
  const blockers = [
    'secret sk-synthetic-secret\r\nnext\u001b',
    'ą'.repeat(600),
    ...Array.from({ length: 21 }, (_, i) => `block ${i}`),
  ];
  writeFileSync(
    s.env.CODEX_TEST_WORKER_REPORT ?? '',
    JSON.stringify({
      status: 'blocked',
      summary: '',
      changed_paths: [],
      findings: [],
      unverified: [],
      blockers,
      checks: Array.from({ length: 23 }, () => ({
        cmd: `${'ą'.repeat(600)}\ncmd`,
        exit_code: -1,
        note: '',
      })),
    }),
  );
  const result = await s.turn('custom-report', true);
  assert.equal(result.code, 4);
  assert.doesNotMatch(result.stderr, /sk-synthetic|\r/);
  assert.ok(!result.stderr.includes(String.fromCharCode(27)));
  assert.match(result.stderr, /blocker: secret \[redacted\] {2}next /);
  assert.match(result.stderr, /truncated; see rounds\/001\/report.json/);
  assert.equal(
    result.stderr.split('\n').filter((x) => x.startsWith('blocker:')).length,
    20,
  );
  assert.equal(
    result.stderr.split('\n').filter((x) => x.startsWith('failing check:'))
      .length,
    20,
  );
  for (const line of result.stderr.split('\n')) {
    if (line.startsWith('blocker: '))
      assert.ok(Buffer.byteLength(line.slice('blocker: '.length)) <= 512);
    if (line.startsWith('failing check: '))
      assert.ok(
        Buffer.byteLength(
          line.slice('failing check: '.length).replace(/ exit -1$/, ''),
        ) <= 512,
      );
  }
  assert.equal(
    result.stderr.split('\n').filter((x) => x === '… 3 more').length,
    2,
  );
});
test('old result files still parse', async () => {
  const { resultSchema } = await import('../../src/worker/state.ts');
  assert.ok(
    resultSchema.safeParse({
      exit_code: 0,
      message: 'done',
      changed: [],
      needs_lead_note: [],
      scope_violations: [],
    }).success,
  );
});
test('timeout without a report prints none and preserves exit 124', async (t) => {
  const s = await setup(t);
  const result = await s.turn('hang', true, ['--timeout-min', '0.02']);
  assert.equal(result.code, 124, result.stderr);
  assert.match(result.stderr, /status: none/);
});
