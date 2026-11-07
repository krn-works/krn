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

const rejectedConfigMessages = [
  '`features.skills` is ignored',
  'The configuration setting `features.skills` is ignored.',
  'Unrecognized configuration key: features.unknown',
  'Unrecognised config setting: features.unknown',
];

test('eval Codex stream remembers rejected configuration after a completed tool turn', () => {
  for (const message of rejectedConfigMessages) {
    const accounting = new SessionUsage();
    accounting.push(
      Buffer.from(jsonl([{ type: 'error', message }]) + codexStream),
    );
    accounting.finish();
    assert.equal(accounting.configRejected, true, message);
    assert.equal(accounting.truncated, false);
  }
  for (const event of [
    { type: 'error', message: 'provider unavailable' },
    { type: 'error', message: 'ignored command output' },
    { type: 'error', message: 'unrecognized model' },
    { type: 'error', message: { config: 'ignored' } },
    { type: 'item.completed', message: rejectedConfigMessages[0] },
  ]) {
    const accounting = new SessionUsage();
    accounting.push(Buffer.from(jsonl([event]) + codexStream));
    accounting.finish();
    assert.equal(accounting.configRejected, false);
  }
});

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
      name: 'error after tool',
      arm: 'A',
      stream: jsonl([
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
