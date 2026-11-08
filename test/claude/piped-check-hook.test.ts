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
