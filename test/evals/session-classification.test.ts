import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { CODEX_CONFIG } from '../../src/evals/session.ts';
import { SessionUsage } from '../../src/evals/usage.ts';
import { requiresIsolation } from '../helpers/isolation.ts';
import {
  capturedCodex,
  codexStream,
  fixture,
  jsonl,
  turn,
} from './session-fixture.ts';

test('eval Codex config disables ambient integrations with recognised settings', () => {
  for (const feature of [
    'apps',
    'plugins',
    'remote_plugin',
    'skill_search',
    'skill_mcp_dependency_install',
    'browser_use',
    'browser_use_external',
    'browser_use_full_cdp_access',
    'computer_use',
    'image_generation',
    'hooks',
    'memories',
  ])
    assert.match(CODEX_CONFIG, new RegExp(`^${feature} = false$`, 'mu'));
  assert.match(CODEX_CONFIG, /^web_search = "disabled"$/mu);
  assert.ok(
    CODEX_CONFIG.indexOf('web_search =') < CODEX_CONFIG.indexOf('[history]'),
  );
  assert.doesNotMatch(
    CODEX_CONFIG,
    /^(skills|multi_agent|goals|tool_suggest) =/mu,
  );
});

test('eval session accounts the captured Codex stream through the harness', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap', 'systemdUserScope'])) return;
  const f = await fixture();
  try {
    const stream = await readFile(capturedCodex);
    await f.scenario(stream);
    const observed = f.invoke(f.args());
    assert.equal(observed.status, 0, observed.stderr);
    const record = JSON.parse(
      await readFile(join(f.output(), 'session.json'), 'utf8'),
    );
    assert.equal(record.status, 'completed');
    assert.deepEqual(record.usage, {
      status: 'complete',
      input_tokens: 20_385,
      output_tokens: 47,
      cached_input_tokens: 12_160,
      reasoning_output_tokens: 0,
      total_tokens: 20_432,
    });
    assert.deepEqual(await readFile(join(f.output(), 'stream.jsonl')), stream);
  } finally {
    await f.cleanup();
  }
});

test('eval usage accounts captured Codex tokens with cached input as a subset', async () => {
  const stream = await readFile(capturedCodex);
  const accounting = new SessionUsage();
  accounting.push(stream);
  accounting.finish();
  assert.deepEqual(accounting.summary(false), {
    status: 'complete',
    input_tokens: 20_385,
    output_tokens: 47,
    cached_input_tokens: 12_160,
    reasoning_output_tokens: 0,
    total_tokens: 20_432,
  });
});

test('eval session distinguishes incomplete streams, invalid usage and infrastructure failures', {
  concurrency: 4,
}, async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap', 'systemdUserScope'])) return;
  const cases = [
    {
      name: 'cut before completion',
      arm: 'A',
      stream: jsonl([{ type: 'turn.started' }]),
      status: 'truncated',
      exit: 0,
    },
    {
      name: 'cut during next turn',
      arm: 'A',
      stream: jsonl([turn(1, 2, 0, 0), { type: 'turn.started' }]),
      status: 'truncated',
      exit: 0,
    },
    { name: 'empty', arm: 'A', stream: '', status: 'truncated', exit: 0 },
    {
      name: 'provider error',
      arm: 'A',
      stream: jsonl([{ type: 'error', message: 'provider unavailable' }]),
      status: 'harness_error',
      exit: 9,
    },
    {
      name: 'mask exit 70 without a turn',
      arm: 'A',
      stream: '',
      status: 'harness_error',
      exit: 70,
    },
    {
      name: 'error after tool',
      arm: 'A',
      stream: jsonl([
        { type: 'turn.started' },
        { type: 'item.started', item: { type: 'command_execution' } },
        { type: 'turn.failed', error: { message: 'failed' } },
      ]),
      status: 'agent_error',
      exit: 7,
    },
    {
      name: 'missing Codex usage',
      arm: 'A',
      stream: jsonl([{ type: 'turn.completed', usage: { input_tokens: 2 } }]),
      status: 'completed',
      exit: 0,
    },
    {
      name: 'invalid UTF-8',
      arm: 'A',
      stream: `${codexStream}\ufffd`,
      status: 'truncated',
      exit: 0,
    },
  ];
  for (const c of cases)
    t.test(c.name, async () => {
      const f = await fixture();
      try {
        await f.scenario(c.stream, c.exit);
        const observed = await f.invokeAsync(f.args(c.arm));
        assert.equal(observed.status, c.exit, observed.stderr);
        const record = JSON.parse(
          await readFile(join(f.output(c.arm), 'session.json'), 'utf8'),
        );
        assert.equal(record.status, c.status);
        assert.equal(record.usage.status, 'missing');
        assert.equal(record.usage.total_tokens, null);
      } finally {
        await f.cleanup();
      }
    });
});
