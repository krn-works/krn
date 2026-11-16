import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows[0].routes.map((route: { name: string }) => route.name),
    ['bash-guards', 'gauge', 'scope', 'edit-standards'],
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
