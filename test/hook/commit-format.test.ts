import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide } from '../../src/hook/commit-format.ts';

const entry = fileURLToPath(
  new URL('../../src/hook/commit-format.ts', import.meta.url),
);
const bash = (command: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command, description: 'commit' },
});

// KRN-12: the real entry the user-scope hook runs, fed the payload Claude Code sends.
function run(command: string) {
  return spawnSync(process.execPath, [entry], {
    input: JSON.stringify(bash(command)),
    encoding: 'utf8',
  });
}

test('the hook refuses a plain commit subject with the expected form', () => {
  const result = run('git commit -m "Update stuff"');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /commit subject "Update stuff"/u);
  assert.match(result.stderr, /type\(scope\): outcome/u);
});

test('the hook passes a conventional commit subject', () => {
  const result = run(
    'git add -A && git commit -m "fix(web): a cached page no longer shows stale prices"',
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('every way to write the subject on the command line is read', () => {
  for (const command of [
    'git commit -am "Update stuff"',
    "git commit --message='Update stuff'",
    'git -C /repo commit -m "Update stuff" -m "fix: body paragraph"',
    'cd /repo; git commit -m"Update stuff"',
    `git commit -m "$(cat <<'EOF'\nUpdate stuff\n\nBody with "quotes" (and parens.\nEOF\n)"`,
    'gh pr create --title "Update stuff" --body x',
    "gh pr edit 12 -t 'Fix the thing.'",
    'gh pr create --title="feat: Adds a thing"',
  ])
    assert.match(decide(bash(command)) ?? '', /^Refused/u, command);
});

test('a call whose subject is not on the command line, or is well formed, passes', () => {
  for (const command of [
    'git commit',
    'git commit -F msg.txt',
    'git commit --amend --no-edit',
    'git commit -m "$SUBJECT"',
    'git commit --fixup HEAD',
    'git commit -m "fixup! Update stuff"',
    'gh pr create --fill',
    'gh pr view 12 --json title',
    'git log --grep "Update stuff"',
    'echo git commit -m "Update stuff" > notes.txt',
    `git commit -m "$(cat <<'EOF'\nfix(web): a cached page no longer shows stale prices (t-abc1234)\n\nUpdate stuff.\nEOF\n)"`,
    'gh pr create --title "fix(ci): ship keeps the worktree (t-abc1234)" --body-file b.md',
  ])
    assert.equal(decide(bash(command)), undefined, command);
  assert.equal(decide({ tool_name: 'Edit', tool_input: {} }), undefined);
});

test('an env wrapper does not hide a malformed subject or title', () => {
  assert.equal(
    decide(bash('env -u GH_TOKEN gh pr create --title "bad title"')) !==
      undefined,
    true,
  );
  assert.equal(
    decide(bash('env GIT_AUTHOR_NAME=bot git commit -m "wip"')) !== undefined,
    true,
  );
  assert.equal(
    decide(
      bash('env -i PATH=/usr/bin git commit -m "fix(hook): env keeps working"'),
    ),
    undefined,
  );
});

test('env -S supplies the command, so later git words are data', () => {
  assert.equal(decide(bash("env -S 'printf %s' git commit -m wip")), undefined);
  assert.notEqual(decide(bash('env git commit -S -m wip')), undefined);
});

test('env --help does not run the command named after it', () => {
  assert.equal(decide(bash('env --help git commit -m wip')), undefined);
});
