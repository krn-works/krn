import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup, snapshot, until, worker } from './input-bounds-fixture.ts';

test('multiline quoted credential assignments are redacted in persisted reports', async (t) => {
  const s = setup(t);
  fs.writeFileSync(
    s.env.CODEX_TEST_WORKER_REPORT ?? '',
    'AUTH="first-line\r\nsynthetic-second-line"\nmetadata: ok {"API_KEY":"synthetic-json"}',
  );
  const result = await s.turn('report-secrets', true);
  assert.equal(result.code, 0, result.stderr);
  const text = fs.readFileSync(join(s.run, 'rounds/001/report.json'), 'utf8');
  assert.equal(text.includes('synthetic-second-line'), false);
  assert.equal(text.includes('synthetic-json'), false);
  assert.match(text, /\[redacted\]/);
});

test('scope path text is redacted before persistence and CLI output', async (t) => {
  const s = setup(t);
  assert.equal((await s.turn('ok', true)).code, 0);
  fs.writeFileSync(join(s.repo, '.krn/AUTH=synthetic-path'), 'data');
  const result = await s.turn('ok');
  assert.equal(result.code, 3, result.stderr);
  assert.equal(result.stderr.includes('synthetic-path'), false);
  const text = fs.readFileSync(join(s.run, 'rounds/002/result.json'), 'utf8');
  assert.equal(text.includes('synthetic-path'), false);
});

test('persisted protocol identifiers and derived token totals have bounds', {
  concurrency: 6,
}, async (t) => {
  for (const scenario of [
    'long-thread',
    'secret-thread',
    'newline-thread',
    'unsafe-usage',
  ]) {
    t.test(scenario, async (t) => {
      const s = setup(t);
      s.env.CODEX_TEST_WORKER_INPUT = scenario;
      const result = await s.turn('ok', true);
      assert.equal(result.code, 65, result.stderr);
      const saved = JSON.parse(
        fs.readFileSync(join(s.run, 'session.json'), 'utf8'),
      );
      await until(() => !worker().alive(saved.pid));
      const stored = JSON.stringify(snapshot(s.run));
      assert.equal(
        stored.includes(Buffer.from('sk-synthetic-thread').toString('hex')),
        false,
      );
    });
  }
});
