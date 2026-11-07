import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodexHost } from '../../src/hosts/codex.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

test('Codex reports missing required counters for each completed turn', async (t) => {
  if (
    !requiresIsolation(t, 'Codex per-turn usage completeness', [
      'systemdUserScope',
    ])
  )
    return;
  const root = await mkdtemp(join(tmpdir(), 'codex-usage-completeness-'));
  const stream = [
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"verdict":"PASS","findings":[]}' },
    },
    { type: 'turn.completed', usage: {} },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"verdict":"PASS","findings":[]}' },
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 8,
        output_tokens: 3,
        cached_input_tokens: 8,
        cache_write_input_tokens: 0,
        reasoning_output_tokens: 3,
      },
    },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"verdict":"PASS","findings":[]}' },
    },
    {
      type: 'turn.completed',
      usage: { output_tokens: 1, cache_write_input_tokens: 1 },
    },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"verdict":"PASS","findings":[]}' },
    },
    { type: 'turn.completed', usage: { input_tokens: '4', output_tokens: 7 } },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"verdict":"PASS","findings":[]}' },
    },
    { type: 'turn.completed', usage: {} },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"verdict":"PASS","findings":[]}' },
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cached_input_tokens: 11,
        cache_write_input_tokens: 2,
        reasoning_output_tokens: 6,
      },
    },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"verdict":"PASS","findings":[]}' },
    },
    { type: 'turn.completed', usage: {} },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"verdict":"PASS","findings":[]}' },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
  const executable = join(root, 'codex-stream');
  await writeFile(
    executable,
    `#!/usr/bin/env node\nawait new Promise((done) => { process.stdin.on("end", done); process.stdin.resume(); });\nprocess.stdout.write(${JSON.stringify(`${stream}\n`)});\n`,
    { mode: 0o700 },
  );
  const host = new CodexHost({ executable });
  try {
    const session = await host.start({
      cwd: root,
      model: 'gpt-6-luna',
      prompt: 'usage observer',
      limits: { timeoutMs: 5000 },
    });
    const result = await session.wait();
    assert.equal(result.claimsDone, false);
    assert.deepEqual(result.usage, {
      inputTokens: 18,
      outputTokens: 16,
      totalTokens: 34,
      cachedInputTokens: 8,
      cacheWriteInputTokens: 2,
      reasoningOutputTokens: 3,
    });
    assert.equal(result.usageObservation.turnsStarted, 8);
    assert.equal(result.usageObservation.turnsCompleted, 7);
    assert.equal(result.usageObservation.invalidFields, 4);
    assert.equal(result.usageObservation.missingRequiredTurns, 5);
  } finally {
    await host.cancelAll();
    await rm(root, { recursive: true, force: true });
  }
});
