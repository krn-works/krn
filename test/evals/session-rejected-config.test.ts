import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { requiresIsolation } from '../helpers/isolation.ts';
import {
  codexStream,
  fixture,
  jsonl,
  rejectedConfigMessages,
} from './session-fixture.ts';

test('eval session classifies a rejected Codex config as harness_error despite completion', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap', 'systemdUserScope'])) return;
  for (const message of rejectedConfigMessages) {
    const f = await fixture();
    try {
      await f.scenario(jsonl([{ type: 'error', message }]) + codexStream);
      const observed = f.invoke(f.args());
      assert.equal(observed.status, 0, observed.stderr);
      const record = JSON.parse(
        await readFile(join(f.output(), 'session.json'), 'utf8'),
      );
      assert.equal(record.status, 'harness_error');
      assert.equal(record.reason, 'config_rejected');
      assert.equal(record.exitCode, 0);
    } finally {
      await f.cleanup();
    }
  }
});
