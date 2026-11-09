import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../scripts/claude/piped-check.ts', import.meta.url),
);
const settings = fileURLToPath(
  new URL('../../.claude/settings.json', import.meta.url),
);

const run = (input: string) =>
  spawnSync(process.execPath, [script], { encoding: 'utf8', input });
const bash = (command: string) =>
  run(
    JSON.stringify({
      session_id: 's',
      hook_event_name: 'PreToolUse',
      cwd: process.cwd(),
      tool_name: 'Bash',
      tool_input: { command },
    }),
  );

test('piped check hook refuses a test, typecheck or lint run piped into a filter', () => {
  for (const command of [
    'npm test | tail',
    'npm run fast 2>&1 | grep FAIL',
    'node --test test/a.test.ts | head',
    'cd sub && CI=1 npx tsc --noEmit |& sed -n 1,20p',
  ]) {
    const result = bash(command);
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /Redirect it to a log, read the exit code/u);
    assert.match(result.stderr, /echo exit=\$\?/u);
    // A refused call drops every command in it, edits included.
    assert.match(result.stderr, /Nothing in this Bash call ran/u);
  }
});

test('piped check hook allows everything it does not classify', () => {
  for (const command of [
    'npm test',
    'npm test > log 2>&1; echo exit=$?',
    'grep FAIL log',
    'tail -n 20 log',
    'git log | head',
    'rg foo src | head',
    'npm test || echo failed',
    '',
  ]) {
    const result = bash(command);
    assert.equal(result.status, 0, command);
    assert.equal(result.stderr, '', command);
  }
  assert.equal(run('{not json').status, 0);
  assert.equal(run('').status, 0);
});

test('repository settings wire the piped check hook to Bash', () => {
  const hooks = JSON.parse(readFileSync(settings, 'utf8')).hooks.PreToolUse as {
    matcher: string;
    hooks: { command: string }[];
  }[];
  const entry = hooks.find((hook) => hook.matcher === 'Bash');
  assert.ok(
    entry?.hooks.some((hook) =>
      hook.command.includes('scripts/claude/piped-check.ts'),
    ),
  );
});

const pollScript = fileURLToPath(
  new URL('../../scripts/claude/ci-poll.ts', import.meta.url),
);
const poll = (command: string) =>
  spawnSync(process.execPath, [pollScript], {
    encoding: 'utf8',
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
  });

test('ci poll hook ignores heredoc text that only mentions watching or polling', () => {
  const command = `cat > note.md <<'EOF'
never run gh pr checks 5 --watch
for i in 1 2; do gh pr view 5; ${'sle' + 'ep'} 60; done
EOF
echo done`;
  const result = poll(command);
  assert.equal(result.status, 0, result.stderr);
});

test('ci poll hook refuses gh watch and sleep loops around gh and names krn ci wait', () => {
  for (const command of [
    'gh run watch 123',
    'gh pr checks 5 --watch',
    'gh pr checks --fail-fast --watch 5',
    'while true; do gh pr view 5 --json state; sleep 60; done',
    'until gh run view 9 --json conclusion | grep success; do sleep 30; done',
    'for i in 1 2 3; do sleep 60; gh api repos/krn-works/krn/commits/x/status; done',
    `python3 -c "import subprocess,time
while True:
    subprocess.run(['gh','pr','view','5'])
    time.${'sle' + 'ep'}(60)"`,
  ]) {
    const result = poll(command);
    assert.equal(result.status, 2, command);
    assert.match(
      result.stderr,
      /bin\/krn ci wait --repo krn-works\/krn --pr <n> --head <sha> --base <sha>/u,
    );
    assert.match(result.stderr, /40-char/u);
  }
});

test('ci poll hook allows krn ci wait, single gh calls and loops not touching gh', () => {
  for (const command of [
    'bin/krn ci wait --repo krn-works/krn --pr 5 --head a --base b',
    'gh pr view 5 --json state',
    'gh run list --limit 3',
    'gh pr checks 5',
    'sleep 5; gh pr view 5',
    'while ! test -f /tmp/x; do sleep 1; done',
    'for f in a b; do echo $f; done',
    '',
  ]) {
    const result = poll(command);
    assert.equal(result.status, 0, command);
    assert.equal(result.stderr, '', command);
  }
  assert.equal(
    spawnSync(process.execPath, [pollScript], { input: '{bad' }).status,
    0,
  );
});

test('repository settings wire the ci poll hook to Bash', () => {
  const hooks = JSON.parse(readFileSync(settings, 'utf8')).hooks.PreToolUse as {
    matcher: string;
    hooks: { command: string }[];
  }[];
  const entry = hooks.find((hook) => hook.matcher === 'Bash');
  assert.ok(
    entry?.hooks.some((hook) =>
      hook.command.includes('scripts/claude/ci-poll.ts'),
    ),
  );
});
