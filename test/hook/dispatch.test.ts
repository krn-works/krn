import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mergeOutputs, runRoutes } from '../../src/dispatch/dispatch.ts';
import type { Route } from '../../src/dispatch/table.ts';

// The receiver is the hook entry Claude Code runs: `node src/dispatch/main.ts <event>` with the payload on stdin.
const root = fileURLToPath(new URL('../..', import.meta.url));
const entry = fileURLToPath(
  new URL('../../src/dispatch/main.ts', import.meta.url),
);

function hook(event: string, payload: object, log?: string) {
  const { KRN_SESSION_CLASS, KRN_ROLE, KRN_SCOPE, KRN_TASK, ...env } =
    process.env;
  return spawnSync(process.execPath, [entry, event], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify({
      session_id: 'dispatch-test',
      transcript_path: join(root, 'no-transcript.jsonl'),
      cwd: root,
      ...payload,
    }),
    env: {
      ...env,
      CLAUDE_PROJECT_DIR: root,
      ...(log === undefined ? {} : { KRN_HOOK_TIMING_LOG: log }),
    },
  });
}

const bash = (command: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
});

test('one pre-tool process refuses a Bash call a guard route refuses', () => {
  const result = hook('pre-tool', bash('git stash'));
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /git stash/u);
});

test('one pre-tool process rewrites a piped check and stays silent for a plain call', () => {
  const rewrite = hook('pre-tool', bash('npm test | tail -5'));
  assert.equal(rewrite.status, 0, rewrite.stderr);
  assert.equal(
    JSON.parse(rewrite.stdout).hookSpecificOutput.updatedInput.command,
    'set -o pipefail; npm test | tail -5',
  );
  const plain = hook('pre-tool', bash('ls'));
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, '');
});

test('the timing log names the routes that matched the tool and nothing else', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'krn-hook-timing-')), 't.jsonl');
  hook('pre-tool', bash('ls'), log);
  hook(
    'pre-tool',
    { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} },
    log,
  );
  const rows = readFileSync(log, 'utf8')
    .split('\n')
    .slice(0, -1)
    .map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows[0].routes.map((route: { name: string }) => route.name),
    ['bash-guards', 'commit-format', 'gauge', 'scope', 'edit-standards'],
  );
  assert.deepEqual(
    rows[1].routes.map((route: { name: string }) => route.name),
    ['gauge'],
  );
  assert.equal(rows[0].event, 'pre-tool');
  assert.equal(typeof rows[0].ms, 'number');
  assert.equal(typeof rows[0].cpu, 'number');
});

test('an unknown event exits 64 and names the events', () => {
  const result = spawnSync(process.execPath, [entry, 'nope'], {
    encoding: 'utf8',
    input: '',
  });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /pre-tool/u);
});

const failing = (name: string, failClosed: boolean): Route => ({
  name,
  failClosed,
  load: () => Promise.reject(new Error('import failed')),
});
const saying = (name: string, text: string): Route => ({
  name,
  load: () =>
    Promise.resolve({
      main: () => {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext: text,
            },
          }),
        );
      },
    }),
});

test('a fail-closed route that cannot load refuses; another is skipped', async () => {
  const closed = await runRoutes([failing('guard', true)], '{}');
  assert.equal(closed.result.code, 2);
  assert.match(closed.result.stderr, /krn hook guard failed: import failed/u);
  const open = await runRoutes(
    [failing('extra', false), saying('a', 'one')],
    '{}',
  );
  assert.equal(open.result.code, 0);
  assert.match(open.result.stdout, /one/u);
  assert.equal(open.timings[0]?.error, 'import failed');
});

test('outputs of several routes merge into one hook output', () => {
  const merged = JSON.parse(
    mergeOutputs([
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"a"}}',
      '',
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"b","permissionDecision":"allow"}}',
    ]),
  );
  assert.deepEqual(merged.hookSpecificOutput, {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    additionalContext: 'a\n\nb',
  });
});

test('a refused PreToolUse payload is refused again after a SessionStart resume or compact', () => {
  const refused = bash('git stash');
  assert.equal(hook('pre-tool', refused).status, 2);
  for (const source of ['resume', 'compact']) {
    const start = hook('session-start', {
      hook_event_name: 'SessionStart',
      source,
    });
    assert.equal(start.status, 0, start.stderr);
    const again = hook('pre-tool', refused);
    assert.equal(again.status, 2, `${source}: ${again.stderr}`);
    assert.match(again.stderr, /git stash/u);
  }
});

function hookAsync(
  event: string,
  payload: object,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { KRN_SESSION_CLASS, KRN_ROLE, KRN_SCOPE, KRN_TASK, ...env } =
    process.env;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, event], {
      cwd: root,
      env: { ...env, CLAUDE_PROJECT_DIR: root },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(
      JSON.stringify({
        session_id: 'dispatch-test',
        transcript_path: join(root, 'no-transcript.jsonl'),
        cwd: root,
        ...payload,
      }),
    );
  });
}

test('parallel PreToolUse payloads get one decision each: the refused call does not drop the allowed one', async () => {
  const [refused, allowed, rewritten] = await Promise.all([
    hookAsync('pre-tool', bash('git stash')),
    hookAsync('pre-tool', bash('ls')),
    hookAsync('pre-tool', bash('npm test | tail -5')),
  ]);
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /git stash/u);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, '');
  assert.equal(rewritten.status, 0, rewritten.stderr);
  assert.equal(
    JSON.parse(rewritten.stdout).hookSpecificOutput.updatedInput.command,
    'set -o pipefail; npm test | tail -5',
  );
});

test('one pre-tool process refuses kill fed by pgrep -f and pkill -f, naming ps as the alternative', () => {
  for (const command of [
    'kill $(pgrep -f x.sh)',
    'kill -9 `pgrep -f x.sh`',
    'pgrep -f x | xargs kill',
    'pkill -f x.sh',
  ]) {
    const result = hook('pre-tool', bash(command));
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /ps -eo pid,args/u, command);
  }
  for (const command of ['kill 1234', 'pgrep -f x', 'kill $(cat pidfile)']) {
    const result = hook('pre-tool', bash(command));
    assert.equal(result.status, 0, command);
    assert.equal(result.stderr, '', command);
  }
});

test('one pre-tool process ignores the kill pattern in quoted data and heredoc bodies but refuses it in a double-quoted substitution', () => {
  for (const command of [
    "echo 'run pkill -f x.sh later' >> status.md",
    'echo "note: pkill -f x.sh" >> status.md',
    "printf '%s' 'kill $(pgrep -f x)'",
    'cat <<EOF > body.md\npkill -f x.sh\nkill $(pgrep -f x)\nEOF',
    "cat <<'EOF' > body.md\npgrep -f x | xargs kill\nEOF",
  ]) {
    const result = hook('pre-tool', bash(command));
    assert.equal(result.status, 0, command);
    assert.equal(result.stderr, '', command);
  }
  for (const command of [
    'kill "$(pgrep -f x.sh)"',
    'echo "x" && pkill -f x.sh',
    "echo 'a' ; kill $(pgrep -f x)",
    'cat <<EOF\nhi\nEOF\npkill -f x',
  ]) {
    const result = hook('pre-tool', bash(command));
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /ps -eo pid,args/u, command);
  }
});
