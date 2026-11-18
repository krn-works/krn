import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  codexCost,
  codexExecArgs,
  codexSessionEnv,
  parseCodexResult,
  rolloutFacts,
  rolloutFiles,
  SOL_MODEL,
  subscriptionLogin,
} from '../../src/harness/codex.ts';

const fixtures = fileURLToPath(new URL('../fixtures/codex/', import.meta.url));
// Verbatim captures of one real `codex exec --json --model gpt-6.2-sol` session: its stdout and the rollout lines
// (turn_context, token_count, task events) its private CODEX_HOME recorded.
const stream = readFileSync(join(fixtures, 'exec-stream.jsonl'), 'utf8');
const rollout = readFileSync(join(fixtures, 'rollout.jsonl'), 'utf8');

test('codex exec arguments: JSON events, the model, no own sandbox, no user config, no web search, pinned effort', () => {
  const a = codexExecArgs({ brief: 'fix it', model: SOL_MODEL });
  assert.deepEqual(a.slice(0, 4), ['exec', '--json', '--model', SOL_MODEL]);
  for (const f of [
    '--dangerously-bypass-approvals-and-sandbox',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
  ])
    assert.ok(a.includes(f), f);
  assert.ok(a.includes('web_search="disabled"'));
  assert.ok(a.includes('model_reasoning_effort="medium"'));
  assert.ok(
    !a.includes('--ephemeral'),
    'the rollout must persist: it names the realized model',
  );
  assert.equal(a.at(-1), 'fix it');
});

test('a real Sol session reads as ok, realized on gpt-6.2-sol, priced from its cumulative usage', () => {
  const r = parseCodexResult(stream, '', [rollout]);
  assert.equal(r.ok, true);
  assert.equal(r.model, 'gpt-6.2-sol');
  assert.equal(r.turns, 1);
  // 47845 input of which 34816 cached, 77 output: (13029 * 2 + 34816 * 0.2 + 77 * 10) / 1e6.
  assert.ok(r.cost !== undefined && Math.abs(r.cost - 0.0337912) < 1e-9);
});

test('the plainest hand-written rollout and stream: one turn_context, one token_count, one turn.completed', () => {
  const plain = [
    '{"type":"turn_context","payload":{"model":"gpt-6.2-sol"}}',
    '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000000,"cached_input_tokens":0,"output_tokens":100000}}}}',
  ].join('\n');
  const r = parseCodexResult('{"type":"turn.completed"}\n', '', [plain]);
  assert.equal(r.ok, true);
  assert.equal(r.model, 'gpt-6.2-sol');
  assert.equal(r.cost, 3);
});

test('a killed session (no turn.completed) is not ok but still charged from its rollout', () => {
  const killed = stream
    .split('\n')
    .filter((l) => !l.includes('turn.completed'))
    .join('\n');
  const r = parseCodexResult(killed, '', [rollout]);
  assert.equal(r.ok, false);
  assert.ok((r.cost ?? 0) > 0);
});

test('a failed turn or an error event (usage limit) is not ok and names the error', () => {
  const r = parseCodexResult(
    '{"type":"thread.started"}\n{"type":"turn.failed","error":{"message":"You have hit your usage limit"}}\n',
    '',
    [],
  );
  assert.equal(r.ok, false);
  assert.match(r.detail, /usage limit/);
  assert.equal(r.cost, undefined);
  assert.equal(r.model, undefined);
  const recovered = parseCodexResult(
    '{"type":"error","message":"Reconnecting... 1/5"}\n{"type":"turn.completed"}\n',
    '',
    [],
  );
  assert.equal(recovered.ok, true);
  const lost = parseCodexResult(
    '{"type":"error","message":"stream disconnected"}\n',
    '',
    [],
  );
  assert.equal(lost.ok, false);
  assert.match(lost.detail, /stream disconnected/);
});

test('a rollout realized on another model keeps that model and is not priced as Sol', () => {
  const other = rollout.replaceAll('gpt-6.2-sol', 'gpt-6.1-sol');
  assert.deepEqual(rolloutFacts(other).models, ['gpt-6.1-sol']);
  const r = parseCodexResult(stream, '', [other]);
  assert.equal(r.model, 'gpt-6.1-sol');
  assert.equal(r.cost, undefined);
  assert.equal(
    codexCost('gpt-6.1-sol', { input: 1, cachedInput: 0, output: 1 }),
    undefined,
  );
});

test('the billing guard refuses an API key in the environment and a login that is not a ChatGPT sign-in', () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-codex-'));
  try {
    const home = join(root, 'host');
    mkdirSync(home);
    const auth = join(home, 'auth.json');
    writeFileSync(auth, '{"auth_mode":"apikey","OPENAI_API_KEY":null}');
    assert.throws(
      () => subscriptionLogin({ CODEX_HOME: home }),
      /not a ChatGPT subscription/,
    );
    writeFileSync(auth, '{"auth_mode":"chatgpt","OPENAI_API_KEY":null}');
    assert.equal(subscriptionLogin({ CODEX_HOME: home }), auth);
    assert.throws(
      () => subscriptionLogin({ CODEX_HOME: home, OPENAI_API_KEY: 'x' }),
      /OPENAI_API_KEY would bill an API key/,
    );
    assert.throws(
      () => subscriptionLogin({ CODEX_HOME: join(root, 'none') }),
      /no readable login/,
    );
    // The session home links only the host login, drops API keys from the session and leaves both writable.
    const session = join(root, 'session-home');
    const { env, writable } = codexSessionEnv(
      session,
      { PATH: '/bin', CODEX_API_KEY: 'y' },
      { CODEX_HOME: home },
    );
    assert.equal(env.CODEX_HOME, session);
    assert.equal(env.CODEX_API_KEY, undefined);
    assert.ok(lstatSync(join(session, 'auth.json')).isSymbolicLink());
    assert.equal(readlinkSync(join(session, 'auth.json')), auth);
    assert.deepEqual(writable, [session, auth]);
    // The session's rollouts are read from its own home.
    const day = join(session, 'sessions', '2026', '11', '18');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'rollout-a.jsonl'), rollout);
    assert.deepEqual(rolloutFiles(session), [join(day, 'rollout-a.jsonl')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
