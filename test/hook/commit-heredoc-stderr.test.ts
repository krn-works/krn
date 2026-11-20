import assert from 'node:assert/strict';
import test from 'node:test';
import { decide } from '../../src/hook/commit-format.ts';

test('a stderr redirect does not hide a literal heredoc commit subject', () => {
  const command =
    'git commit -m "$(cat <<\'EOF\' 2>/dev/null\nUpdate stuff\nEOF\n)"';
  const refusal = decide({ tool_name: 'Bash', tool_input: { command } });
  assert.match(refusal ?? '', /commit subject "Update stuff"/);
});
