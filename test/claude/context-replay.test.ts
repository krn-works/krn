import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { hookEvents, replay } from '../../scripts/claude/context-replay.ts';

// mid-step.jsonl is six verbatim lines (content elided by capture-fixture) of
// one lead turn recorded before the gauge existed: the operator prompt, two
// tool calls under 240k, a tool call at 243k and the turn's end at 273k.
const fixture = fileURLToPath(
  new URL('fixtures/mid-step.jsonl', import.meta.url),
);
const transcript = readFileSync(fixture, 'utf8');

test('replay maps tool results and operator prompts to hook events', () => {
  assert.deepEqual(hookEvents(transcript.split('\n')), [
    { line: 0, event: 'UserPromptSubmit' },
    { line: 2, event: 'PostToolUse' },
    { line: 4, event: 'PostToolUse' },
  ]);
});

test('the real gauge hook advises inside the step that crosses the threshold', () => {
  const result = replay(transcript, 400000);
  assert.equal(result.peak, 273175);
  assert.deepEqual(result.advisories, [
    {
      line: 4,
      event: 'PostToolUse',
      total: 243274,
      midStep: true,
      stepPeak: 273175,
    },
  ]);
  // A window the turn never reaches stays silent.
  assert.deepEqual(replay(transcript, 500000).advisories, []);
});

test('replay CLI prints one verdict per transcript and rejects no input', () => {
  const script = fileURLToPath(
    new URL('../../scripts/claude/context-replay.ts', import.meta.url),
  );
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const ok = run('--window', '400000', fixture);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(
    JSON.parse(ok.stdout).verdict,
    'mid-step at 243k (step peaked 273k)',
  );
  const bad = run();
  assert.equal(bad.status, 64);
  assert.equal(bad.stdout, '');
});
