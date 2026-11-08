import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { requiresIsolation } from '../helpers/isolation.ts';
import { codexCapture, fixture } from './session-fixture.ts';

test('eval session classifies a rejected Codex config as harness_error despite completion', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap', 'systemdUserScope'])) return;
  const capture = await codexCapture('config-ignored');
  const f = await fixture();
  try {
    await f.scenario(capture.stdout, capture.exitCode);
    const observed = f.invoke(f.args());
    assert.equal(observed.status, 0, observed.stderr);
    const record = JSON.parse(
      await readFile(join(f.output(), 'session.json'), 'utf8'),
    );
    assert.equal(record.status, 'harness_error');
    assert.equal(record.reason, 'config_rejected');
    assert.equal(record.exitCode, 0);
    assert.equal(record.usage.total_tokens, 10_832);
  } finally {
    await f.cleanup();
  }
});
