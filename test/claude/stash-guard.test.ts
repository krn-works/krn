import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide } from '../../scripts/claude/stash-guard.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
// PreToolUse payload shape for Bash, as the other Bash hooks receive it.
const bash = (command: string) => ({
  tool_name: 'Bash',
  tool_input: { command },
});

test('stash forms that change the shared stack are refused', () => {
  for (const command of [
    'git stash',
    'git stash pop',
    'git stash push -u -m tag',
    'git stash save wip',
    'git stash drop stash@{0}',
    'git stash clear',
    'git -C .krn/worktrees/x stash',
    'npm run fast && git stash && git pull',
    'cd /r; git stash pop',
  ])
    assert.match(decide(bash(command)) ?? '', /^Refused: `git stash/u, command);
});

test('reading the stack, applying by sha and unrelated commands are allowed', () => {
  for (const command of [
    'git stash list',
    "git stash list --format='%H %gs'",
    'git stash show -p abc123',
    'git stash apply e796d34',
    'git status --short',
    'echo git stash is shared',
    "cat > notes.md <<'X'\ngit stash pop\nX",
  ])
    assert.equal(decide(bash(command)), undefined, command);
  assert.equal(decide({ tool_input: {} }), undefined);
});

test('the hook exits 2 with the reason on stderr', () => {
  const run = spawnSync(
    process.execPath,
    [join(root, 'scripts/claude/stash-guard.ts')],
    { input: JSON.stringify(bash('git stash')), encoding: 'utf8' },
  );
  assert.equal(run.status, 2);
  assert.match(run.stderr, /WIP commit/u);
});
