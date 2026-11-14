import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { isWorkerSession } from '../../src/hook/session.ts';

test('informational hooks are silent in a worker session and speak for the lead', () => {
  assert.equal(isWorkerSession({ KRN_ROLE: 'worker' }), true);
  assert.equal(isWorkerSession({ KRN_SESSION_CLASS: 'lane' }), true);
  assert.equal(isWorkerSession({}), false);
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    cwd: '/nonexistent',
  });
  for (const hook of ['context-gauge', 'subagent-hook-errors'])
    assert.equal(
      execFileSync(
        'node',
        [new URL(`../../scripts/claude/${hook}.ts`, import.meta.url).pathname],
        {
          input: payload,
          encoding: 'utf8',
          env: { ...process.env, KRN_ROLE: 'worker' },
        },
      ),
      '',
    );
});
