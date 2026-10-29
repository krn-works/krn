import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Fixtures are Claude Code transcript lines captured from a lead session:
// message content arrays are elided and cwd is redacted to '.', every other
// field, including message.usage, is verbatim.

const script = fileURLToPath(
  new URL('../../scripts/claude/context-gauge.ts', import.meta.url),
);
const fixture = (name: string) =>
  readFileSync(new URL(`fixtures/${name}.jsonl`, import.meta.url), 'utf8');

test('gauge exports a pure last main-chain context reader', async () => {
  assert.ok(existsSync(script), 'gauge script exists');
  const module = await import(script);
  assert.equal(typeof module.contextTotal, 'function');
  for (const [name, total] of [
    ['below', 95053],
    ['warn', 121481],
    ['second', 163398],
  ] as const) {
    assert.equal(module.contextTotal(fixture(name)), total);
  }
  assert.equal(
    module.contextTotal(`${fixture('second')}\n${fixture('below')}`),
    95053,
  );
});

test('gauge hook advises once per threshold and re-arms after compaction', () => {
  assert.ok(existsSync(script), 'gauge script exists');
  const root = mkdtempSync(join(tmpdir(), 'context-gauge-'));
  const transcript = join(root, 'transcript.jsonl');
  const run = (text: string, event = 'PostToolUse') => {
    writeFileSync(transcript, text);
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'session',
        transcript_path: transcript,
        hook_event_name: event,
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    if (result.stdout)
      assert.equal(
        JSON.parse(result.stdout).hookSpecificOutput.hookEventName,
        event,
      );
    return result.stdout;
  };
  try {
    assert.equal(run(fixture('below')), '');
    assert.match(
      run(fixture('warn'), 'UserPromptSubmit'),
      /Context at 121k of 200k\. Finish the current step, then run krn-handoff\./u,
    );
    assert.equal(run(fixture('warn')), '');
    assert.match(run(fixture('second')), /163k.*200k.*krn-handoff/u);
    assert.equal(run(fixture('second')), '');
    assert.equal(run(fixture('compact-boundary')), '');
    assert.match(run(fixture('warn')), /121k/u);
    assert.match(run(fixture('second')), /163k/u);
    // A second compaction followed directly by a reading above 120k re-arms
    // too; derived from the captured boundary by changing its uuid only.
    const captured = JSON.parse(
      fixture('compact-boundary').split('\n')[0] ?? '',
    );
    const boundary = JSON.stringify({ ...captured, uuid: 'second-compaction' });
    assert.match(run(`${boundary}\n${fixture('warn')}`), /121k/u);
    assert.equal(run(`${boundary}\n${fixture('warn')}`), '');
    // A partial last line from the transcript writer does not hide the reading.
    assert.match(
      run(`${boundary}\n${fixture('second')}\n{"type":"assi`),
      /163k/u,
    );
    // A compaction whose boundary already left the read window still re-arms:
    // context drops from 163k to 121k with no boundary line in the transcript.
    assert.match(run(fixture('warn')), /121k/u);
    assert.equal(run(fixture('warn')), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gauge hook gives both advisories when one reading passes both thresholds', () => {
  assert.ok(existsSync(script), 'gauge script exists');
  const root = mkdtempSync(join(tmpdir(), 'context-gauge-'));
  const transcript = join(root, 'transcript.jsonl');
  try {
    writeFileSync(transcript, fixture('second'));
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'session',
        transcript_path: transcript,
        hook_event_name: 'PostToolUse',
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    const text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(
      text,
      /163k of 200k\. Finish the current step, then run krn-handoff\./u,
    );
    assert.match(text, /nearly exhausted/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gauge hook fails silently for malformed, missing and sidechain inputs', () => {
  assert.ok(existsSync(script), 'gauge script exists');
  const root = mkdtempSync(join(tmpdir(), 'context-gauge-'));
  const transcript = join(root, 'transcript.jsonl');
  const run = (input: string) => {
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf8',
      input,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  };
  const input = JSON.stringify({
    session_id: 'session',
    transcript_path: transcript,
    hook_event_name: 'PostToolUse',
  });
  try {
    run(input); // missing file
    run('{');
    run('{}');
    writeFileSync(transcript, '{malformed line\n');
    run(input);
    // Derived from the verbatim warn capture by flipping isSidechain only.
    writeFileSync(
      transcript,
      fixture('warn').replaceAll('"isSidechain": false', '"isSidechain": true'),
    );
    run(input);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gauge reads only the final 256 KiB and skips the partial first line', () => {
  assert.ok(existsSync(script), 'gauge script exists');
  const root = mkdtempSync(join(tmpdir(), 'context-gauge-'));
  const transcript = join(root, 'transcript.jsonl');
  try {
    // Malformed old data is outside the read window; the long user line straddles it.
    writeFileSync(
      transcript,
      `malformed old line\n${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(270000) } })}\n${fixture('warn')}`,
    );
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'session',
        transcript_path: transcript,
        hook_event_name: 'PostToolUse',
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /121k of 200k/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
