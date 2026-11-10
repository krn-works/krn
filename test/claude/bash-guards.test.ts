import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../scripts/claude/bash-guards.ts', import.meta.url),
);
const run = (command: string) =>
  spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    input: JSON.stringify({
      tool_name: 'Bash',
      cwd: process.cwd(),
      tool_input: { command },
    }),
  });

test('the combined Bash guard refuses what each separate guard refuses', () => {
  for (const [command, name] of [
    ['git stash', 'git stash'],
    ['gh run watch 123', 'polls CI'],
    ['npm test | tail -5 || true', 'swallows its failure'],
  ] as const) {
    const result = run(command);
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, new RegExp(name, 'u'));
  }
});

test('the combined Bash guard rewrites a piped check and allows other commands', () => {
  const rewrite = run('npm test | tail -5');
  assert.equal(rewrite.status, 0);
  assert.equal(
    JSON.parse(rewrite.stdout).hookSpecificOutput.updatedInput.command,
    'set -o pipefail; npm test | tail -5',
  );
  const plain = run('ls');
  assert.equal(plain.status, 0);
  assert.equal(plain.stdout, '');
});

test('a refusal wins over the piped check rewrite', () => {
  const result = run('npm test | tail -5; git stash');
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
});

test('the combined Bash guard ignores unreadable input', () => {
  const result = spawnSync(process.execPath, [script], { input: '{bad' });
  assert.equal(result.status, 0);
});
