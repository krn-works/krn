import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { alias, updatedInput } from '../../scripts/claude/subagent-model.ts';

// Receiver evidence (live, Claude Code 2.1.316, 2026-11-09): `claude -p --model opus`
// spawning Explore with no model ran claude-opus-5-5 without this hook and
// claude-sonnet-5-5 with it, under CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-5-5
// (.krn/runs/token-audit/subagent-model-audit.md).

const script = fileURLToPath(
  new URL('../../scripts/claude/subagent-model.ts', import.meta.url),
);
const settings = fileURLToPath(
  new URL('../../.claude/settings.json', import.meta.url),
);
const call = (input: Record<string, unknown>) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_input: input,
});

test('Explore and Plan without a model get the configured subagent alias', () => {
  for (const subagent_type of ['Explore', 'Plan']) {
    assert.deepEqual(
      updatedInput(call({ subagent_type, prompt: 'p' }), 'claude-sonnet-5-5'),
      { subagent_type, prompt: 'p', model: 'sonnet' },
    );
  }
  assert.equal(alias('haiku'), 'haiku');
  assert.equal(alias('claude-fable-5-1'), 'fable');
  assert.equal(alias('custom-model'), undefined);
});

test('explicit models, other agent types and an unset variable stay untouched', () => {
  const env = 'sonnet';
  assert.equal(
    updatedInput(call({ subagent_type: 'Explore', model: 'opus' }), env),
    undefined,
  );
  for (const subagent_type of ['general-purpose', 'fork', 'krn-reader'])
    assert.equal(updatedInput(call({ subagent_type }), env), undefined);
  assert.equal(updatedInput(call({ prompt: 'p' }), env), undefined);
  assert.equal(
    updatedInput(call({ subagent_type: 'Explore' }), undefined),
    undefined,
  );
  assert.equal(updatedInput(null, env), undefined);
});

test('the hook prints updatedInput and stays silent otherwise', () => {
  const run = (input: Record<string, unknown>) =>
    spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      input: JSON.stringify(call(input)),
      env: { ...process.env, CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5-5' },
    });
  const filled = run({ subagent_type: 'Explore', prompt: 'p' });
  assert.equal(filled.status, 0);
  assert.deepEqual(JSON.parse(filled.stdout), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { subagent_type: 'Explore', prompt: 'p', model: 'sonnet' },
    },
  });
  const silent = run({ subagent_type: 'general-purpose' });
  assert.equal(silent.status, 0);
  assert.equal(silent.stdout, '');
});

test('project settings run the hook before every Agent call', () => {
  const hooks = JSON.parse(readFileSync(settings, 'utf8')).hooks
    .PreToolUse as Array<{
    matcher: string;
    hooks: Array<{ command: string }>;
  }>;
  const entry = hooks.find((hook) =>
    hook.hooks.some((h) => h.command.includes('subagent-model.ts')),
  );
  assert.ok(entry, 'subagent-model hook missing from .claude/settings.json');
  assert.ok(entry.matcher.split('|').includes('Agent'));
});
