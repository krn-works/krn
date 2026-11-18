import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../scripts/claude/subagent-model.ts', import.meta.url),
);

function run(toolInput: Record<string, unknown>) {
  const out = spawnSync(process.execPath, [script], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: toolInput,
    }),
    encoding: 'utf8',
  });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim() ? JSON.parse(out.stdout) : undefined;
}

test('an isolated krn-lane or general-purpose call is refused and names krn lane start', () => {
  for (const subagent_type of ['krn-lane', 'general-purpose']) {
    const out = run({ subagent_type, prompt: 'p', isolation: 'worktree' });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(
      out.hookSpecificOutput.permissionDecisionReason,
      /krn lane start/,
    );
    assert.equal(out.hookSpecificOutput.updatedInput, undefined);
  }
});

test('a plain lane call is not refused', () => {
  const out = run({ subagent_type: 'krn-lane', prompt: 'p' });
  assert.equal(out?.hookSpecificOutput?.permissionDecision, undefined);
});

test('an isolated call of another agent type is not refused', () => {
  const out = run({
    subagent_type: 'Explore',
    prompt: 'p',
    isolation: 'worktree',
    model: 'haiku',
  });
  assert.equal(out, undefined);
});
