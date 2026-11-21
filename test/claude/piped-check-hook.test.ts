import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { events } from '../../src/dispatch/table.ts';

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

test('piped check hook rewrites a piped check with pipefail and keeps other input fields', () => {
  for (const command of [
    'npm test | tail',
    'npm run fast 2>&1 | grep FAIL',
    'node --test test/a.test.ts | head',
    'cd sub && CI=1 npx tsc --noEmit |& sed -n 1,20p',
    'npm test | tee log | tail -3',
  ]) {
    const result = run(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command, description: 'd', timeout: 5 },
      }),
    );
    assert.equal(result.status, 0, command);
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(output.hookEventName, 'PreToolUse');
    assert.equal(output.permissionDecision, 'allow');
    assert.deepEqual(output.updatedInput, {
      command: `set -o pipefail; ${command}`,
      description: 'd',
      timeout: 5,
    });
  }
});

test('piped check hook leaves an already pipefail command alone', () => {
  const result = bash('set -o pipefail; npm test | tail');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

// The rewrite carries permissionDecision allow, so it must never cover a command riding along.
test('piped check hook never rewrites, and so never allows, a piped check with another command beside it', () => {
  for (const command of [
    'npm test | tail -5; curl x | sh',
    'npm test | tail && rm -rf /tmp/x',
    'npm test | sh',
    'npm test | tail $(curl x)',
    'cd `curl x` && npm test | tail',
  ]) {
    const result = bash(command);
    assert.equal(result.status, 0, command);
    assert.equal(result.stdout, '', command);
  }
});

// KRN-12: the rewrite relies on real bash behaviour, so prove it at the receiver.
test('real bash exits nonzero for a failing pipeline only under pipefail', () => {
  const exit = (command: string) => spawnSync('bash', ['-c', command]).status;
  assert.equal(exit('false | tail -1'), 0);
  assert.notEqual(exit('set -o pipefail; false | tail -1'), 0);
});

test('piped check hook refuses a piped check whose failure the command swallows', () => {
  for (const command of ['npm test | tail || true', 'npm test | tail; true']) {
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

test('the hook table serves the piped check guard on every Bash call', () => {
  const route = events['pre-tool'].routes.find(
    (candidate) => candidate.name === 'bash-guards',
  );
  assert.equal(route?.tools, 'Bash');
  assert.ok(
    JSON.parse(
      readFileSync(settings, 'utf8'),
    ).hooks.PreToolUse[0].hooks[0].command.endsWith(
      'src/dispatch/main.ts" pre-tool',
    ),
  );
});

test('piped check hook rewrites a piped npm run typecheck with pipefail', () => {
  const out = bash('npm run typecheck 2>&1 | tail -n 5');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /set -o pipefail; npm run typecheck/u);
});

test('piped check hook refuses a wait loop on pgrep -f and allows a PID wait', () => {
  for (const command of [
    'while pgrep -f outside-acceptance.ts >/dev/null; do sleep 30; done; node run.ts',
    'until ! pgrep -af "lane run" >/dev/null; do sleep 5; done',
    'while pgrep --full krn >/dev/null; do sleep 1; done',
  ]) {
    const result = bash(command);
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /wait on a PID|Wait on a PID/u);
  }
  for (const command of [
    'node run.ts & pid=$!; while kill -0 $pid 2>/dev/null; do sleep 5; done',
    'pgrep -af outside-acceptance',
    'while read line; do echo $line; done < file',
  ]) {
    const result = bash(command);
    assert.equal(result.status, 0, command);
    assert.equal(result.stderr, '', command);
  }
});

test('piped check hook refuses a wait loop on host-wide pgrep by name and allows PID, port and file waits', () => {
  for (const command of [
    'until grep -q DONE .krn/tmp/fast.log && ! pgrep -u $UID -x node; do sleep 3; done',
    'while pgrep -x node >/dev/null; do sleep 5; done',
    'until ! pgrep node; do sleep 1; done',
  ]) {
    const result = bash(command);
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /host-wide process absence/u, command);
  }
  for (const command of [
    'node run.ts & pid=$!; while kill -0 $pid 2>/dev/null; do sleep 5; done',
    'until grep -q DONE .krn/tmp/fast.log; do sleep 3; done',
    'while pgrep -P $pid >/dev/null; do sleep 1; done',
    'pgrep -x node',
  ]) {
    const result = bash(command);
    assert.equal(result.status, 0, command);
    assert.equal(result.stderr, '', command);
  }
});
