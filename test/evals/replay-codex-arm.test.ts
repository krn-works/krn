import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { driveSession, sessionRan } from '../../evals/replay/session.ts';
import {
  SESSION_MODEL,
  sessionArgv,
  sessionBinary,
} from '../../evals/replay/session-args.ts';
import {
  parseCodexResult,
  rolloutFiles,
  SOL_MODEL,
} from '../../src/harness/codex.ts';

const fixtures = fileURLToPath(new URL('../fixtures/codex/', import.meta.url));

test('a Sol arm runs the same brief on codex exec; a Claude arm keeps claude -p with its denied tools', () => {
  const sol = sessionArgv({
    bin: 'codex',
    prompt: 'Fix the bug',
    settings: '/s/arm-a.json',
    model: SOL_MODEL,
  });
  assert.deepEqual(sol.slice(0, 5), [
    'codex',
    'exec',
    '--json',
    '--model',
    SOL_MODEL,
  ]);
  assert.equal(sol.at(-1), 'Fix the bug');
  assert.ok(!sol.includes('--fallback-model'), 'escalation is its own attempt');
  const sonnet = sessionArgv({
    bin: 'claude',
    prompt: 'Fix the bug',
    settings: '/s/arm-a.json',
  });
  assert.deepEqual(sonnet.slice(0, 3), ['claude', '-p', 'Fix the bug']);
  assert.ok(sonnet.includes('--disallowedTools'));
  assert.equal(sonnet[sonnet.indexOf('--model') + 1], SESSION_MODEL);
});

test('the session binary follows the model: KRN_EVAL_CODEX for a Codex model, KRN_EVAL_CLAUDE otherwise', () => {
  const env = { KRN_EVAL_CODEX: '/x/codex', KRN_EVAL_CLAUDE: '/x/claude' };
  assert.equal(sessionBinary(SOL_MODEL, env), '/x/codex');
  assert.equal(sessionBinary(undefined, env), '/x/claude');
  assert.equal(sessionBinary('opus', env), '/x/claude');
  assert.equal(sessionBinary(SOL_MODEL, {}), 'codex');
});

// A stand-in codex that replays the captured stream and writes the captured rollout into its CODEX_HOME, then
// optionally hangs, so the driver's Codex reader is exercised end to end without a paid session.
function stub(root: string, hang: boolean): string {
  const bin = join(root, 'codex');
  writeFileSync(
    bin,
    `#!/bin/sh\nd="$CODEX_HOME/sessions/2026/11/18"\nmkdir -p "$d"\ncp ${join(fixtures, 'rollout.jsonl')} "$d/rollout-x.jsonl"\n${hang ? 'sleep 30\n' : `cat ${join(fixtures, 'exec-stream.jsonl')}\n`}`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

async function drive(hang: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'krn-codex-arm-'));
  try {
    const home = join(root, 'home');
    mkdirSync(home);
    const env = { PATH: process.env.PATH, CODEX_HOME: home };
    const bin = stub(root, hang);
    return await driveSession({
      command: bin,
      argv: sessionArgv({
        bin,
        prompt: 'p',
        settings: 's',
        model: SOL_MODEL,
      }).slice(1),
      cwd: root,
      env,
      timeoutMs: hang ? 500 : 20_000,
      claude: bin,
      parse: (stdout, stderr) =>
        parseCodexResult(
          stdout,
          stderr,
          rolloutFiles(home).map((f) => readFileSync(f, 'utf8')),
        ),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the driver reads a Codex session through its reader: realized model and cost on the row', async () => {
  const s = await drive(false);
  assert.equal(sessionRan(s), true);
  assert.equal(s.result.model, 'gpt-6.2-sol');
  assert.ok((s.result.cost ?? 0) > 0);
});

test('a Codex session killed at its time limit still carries its spend and realized model', async () => {
  const s = await drive(true);
  assert.equal(s.timedOut, true);
  assert.equal(s.result.ok, false);
  assert.equal(s.result.model, 'gpt-6.2-sol');
  assert.ok((s.result.cost ?? 0) > 0);
});
