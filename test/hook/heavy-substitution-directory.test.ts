import assert from 'node:assert/strict';
import test from 'node:test';
import { judge } from '../../src/hook/heavy-command.ts';

test('a substitution cwd does not exempt a later test in the parent shell', () => {
  const command = 'printf "%s\\n" "$(cd /tmp && pwd)"; npm test';
  assert.ok(
    judge(
      { tool_name: 'Bash', cwd: '/var', tool_input: { command } },
      {},
      { exclude: ['tmp'], heavy: [] },
    ),
  );
});
