import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gatedAttempt } from '../../evals/replay/arm-session.ts';
import {
  attemptVerdict,
  claudeFacts,
  codexFacts,
  gateRefusal,
  isTestCommand,
} from '../../evals/replay/attempt.ts';
import {
  type DrivenSession,
  driveSession,
} from '../../evals/replay/session.ts';
import { sessionArgv } from '../../evals/replay/session-args.ts';
import { parseSessionResult } from '../../evals/replay/session-result.ts';
import { codexResumeArgs } from '../../src/harness/codex.ts';

const fixtures = fileURLToPath(new URL('../fixtures/replay/', import.meta.url));
// Verbatim captures (account state removed) of one real session per harness that ran `make test` once, and of its
// resume: `claude -p --output-format stream-json --verbose` and `codex exec --json` / `codex exec resume --json`.
const capture = (name: string) =>
  readFileSync(join(fixtures, `${name}.jsonl`), 'utf8');

test('both harness streams show tool calls, the test command with its exit, the stop reason and the session id', () => {
  const claude = claudeFacts(capture('claude-stream'));
  assert.equal(claude.toolCalls, 1);
  assert.deepEqual(
    claude.tests.map((t) => [t.command, t.ok]),
    [['make test', true]],
  );
  assert.equal(claude.stopReason, 'end_turn');
  assert.equal(claude.sessionId, 'cd49d96c-a31c-4a2b-9cbb-098957179723');
  const codex = codexFacts(capture('codex-stream'));
  assert.equal(codex.toolCalls, 1);
  assert.deepEqual(
    codex.tests.map((t) => [t.command, t.ok]),
    [["/usr/bin/bash -lc 'make test'", true]],
  );
  assert.equal(codex.stopReason, 'end_turn');
  assert.equal(codex.sessionId, '01a1ee27-e5e0-7ea2-bc7d-0943e38655ba');
  assert.equal(codexFacts(capture('codex-resume')).tests.length, 1);
});

test('a stream-json result reads like a json result: cost, model and success', () => {
  const r = parseSessionResult(
    capture('claude-stream'),
    '',
    () => undefined,
    () => undefined,
    () => undefined,
  );
  assert.equal(r.ok, true);
  assert.equal(r.model, 'claude-sonnet-5-5');
  assert.ok((r.cost ?? 0) > 0);
});

test('test commands of every unit stack count; a commit message naming a test does not', () => {
  for (const c of [
    'go test ./...',
    'timeout 240 go test -count=1 ./pkg/',
    'npm test',
    'npx vitest run src/a.test.ts',
    'pytest -q tests/x.py',
    'vendor/bin/phpunit tests',
    'cd x && node --test test/',
  ])
    assert.ok(isTestCommand(c), c);
  for (const c of ['git commit -m "add test"', 'ls test/', 'cat go.mod'])
    assert.ok(!isTestCommand(c), c);
});

test('the gate lets a session end only after a passing last test run', () => {
  assert.match(
    gateRefusal({ toolCalls: 0, tests: [], stopReason: 'end_turn' }) ?? '',
    /without running any test/u,
  );
  const failing = gateRefusal({
    toolCalls: 2,
    tests: [
      { command: 'go test ./a', ok: true, output: 'ok' },
      { command: 'go test ./b', ok: false, output: '--- FAIL: TestB' },
    ],
    stopReason: 'end_turn',
  });
  assert.match(failing ?? '', /go test \.\/b[\s\S]*--- FAIL: TestB/u);
  assert.equal(
    gateRefusal({
      toolCalls: 1,
      tests: [{ command: 'go test ./a', ok: true, output: 'ok' }],
      stopReason: 'end_turn',
    }),
    undefined,
  );
});

const driven = (stdout: string, cost: number, ok = true): DrivenSession => ({
  result: { ok, detail: 'd', cost, model: 'm' },
  notStarted: false,
  timedOut: false,
  stdout,
  stderr: '',
});

test('both arms meet the same gate: a session that ended untested is resumed once with the refusal', async () => {
  const untestedClaude =
    '{"type":"result","subtype":"success","is_error":false,"session_id":"s-1","stop_reason":"end_turn"}';
  const untestedCodex =
    '{"type":"thread.started","thread_id":"th-1"}\n{"type":"turn.completed"}';
  for (const [harness, first, second, cost] of [
    ['claude', untestedClaude, capture('claude-stream'), 0.3],
    ['codex', untestedCodex, capture('codex-stream'), 0.2],
  ] as const) {
    const turns: { prompt: string; resume?: string; usd: number }[] = [];
    const sessions = [driven(first, 0.1), driven(second, 0.2)];
    const a = await gatedAttempt(
      harness,
      'Fix it',
      { ms: 60_000, usd: 5 },
      async (t) => {
        turns.push(t);
        return sessions.shift() as DrivenSession;
      },
    );
    assert.equal(turns.length, 2, harness);
    assert.equal(turns[0]?.prompt, 'Fix it');
    assert.equal(turns[1]?.resume, harness === 'claude' ? 's-1' : 'th-1');
    assert.match(turns[1]?.prompt ?? '', /without running any test/u);
    assert.equal(turns[1]?.usd, 4.9, 'the re-prompt spends what is left');
    assert.equal(a.fields.reprompted, true);
    assert.equal(a.fields.testsRun, 1);
    assert.equal(a.fields.toolCalls, 1);
    assert.equal(a.fields.stopReason, 'end_turn');
    // Claude reports each run's own spend; Codex's rollout is cumulative.
    assert.ok(Math.abs((a.fields.cost ?? 0) - cost) < 1e-9, harness);
  }
});

test('a capped or timed-out session is not re-prompted, and its stop reason says why', async () => {
  let calls = 0;
  const capped = await gatedAttempt(
    'claude',
    'Fix it',
    { ms: 60_000, usd: 5 },
    async () => {
      calls++;
      return {
        ...driven('{"type":"result","subtype":"error_max_budget_usd"}', 5),
        result: { ok: false, detail: 'capped', cost: 5, capped: true },
      };
    },
  );
  assert.equal(calls, 1);
  assert.equal(capped.fields.stopReason, 'budget');
  assert.equal(capped.ran, true);
});

test('a session that ran no test and changed nothing is a no-attempt, not a fail', () => {
  assert.equal(
    attemptVerdict({ ran: true, testsRun: 0, changed: false, pass: false }),
    'no-attempt',
  );
  assert.equal(
    attemptVerdict({ ran: true, testsRun: 0, changed: true, pass: false }),
    'fail',
  );
  assert.equal(
    attemptVerdict({ ran: true, testsRun: 2, changed: false, pass: true }),
    'pass',
  );
  assert.equal(
    attemptVerdict({
      ran: false,
      testsRun: 0,
      changed: false,
      pass: undefined,
    }),
    'not-run',
  );
});

test('every arm streams its full event log, runs without a fallback model and resumes the same session', () => {
  const claude = sessionArgv({ bin: 'claude', prompt: 'p', settings: '/s' });
  assert.ok(!claude.includes('--fallback-model'));
  assert.equal(claude[claude.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(claude.includes('--verbose'));
  const resumed = sessionArgv({
    bin: 'claude',
    prompt: 'again',
    settings: '/s',
    resume: 's-1',
  });
  assert.equal(resumed[resumed.indexOf('--resume') + 1], 's-1');
  assert.equal(resumed[resumed.indexOf('-p') + 1], 'again');
  const sol = codexResumeArgs({
    brief: 'again',
    model: 'gpt-6.2-sol',
    id: 'th-1',
  });
  assert.deepEqual(sol.slice(0, 3), ['exec', 'resume', '--json']);
  assert.deepEqual(sol.slice(-2), ['th-1', 'again']);
  assert.ok(sol.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('the driver kills a session at its dollar cap when the harness has none of its own', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'krn-budget-'));
  try {
    const stub = join(dir, 'hang');
    writeFileSync(stub, '#!/bin/sh\nsleep 30\n');
    chmodSync(stub, 0o755);
    let spent = 0;
    const s = await driveSession({
      command: stub,
      argv: [],
      cwd: dir,
      env: process.env,
      timeoutMs: 20_000,
      claude: stub,
      parse: () => ({ ok: true, detail: 'x', cost: spent }),
      budget: {
        usd: 5,
        spent: () => {
          spent += 2;
          return spent;
        },
        everyMs: 50,
      },
    });
    assert.equal(s.timedOut, false, 'the cap, not the time limit, ended it');
    assert.equal(s.result.capped, true);
    assert.equal(s.result.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
