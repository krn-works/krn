import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
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
import { deliver, scan } from '../../scripts/claude/subagent-hook-errors.ts';

// Receiver evidence: the fixture line is a real subagent transcript entry (Claude Code
// 2.1.319, agent a8b33ced368d8967c) where a PreToolUse:Bash hook refused a call. The
// SubagentStop input shape and the rule that only PostToolUse reaches the parent are from
// https://code.claude.com/docs/en/hooks (#subagentstop, #posttooluse).

const script = fileURLToPath(
  new URL('../../scripts/claude/subagent-hook-errors.ts', import.meta.url),
);
const fixture = fileURLToPath(
  new URL('./transcripts/subagent-hook-error.jsonl', import.meta.url),
);

const run = (payload: object, root: string) =>
  spawnSync('node', [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });

test('a captured hook refusal counts once with a clipped message', () => {
  const found = scan(readFileSync(fixture, 'utf8'));
  assert.equal(found.count, 1);
  assert.match(found.first[0] ?? '', /^PreToolUse:Bash hook error: Refused: /u);
  assert.ok(
    (found.first[0] ?? '').length <=
      'PreToolUse:Bash hook error: '.length + 100,
  );
  assert.equal(
    scan('{"type":"user","message":{"content":"fine"}}\nnot json').count,
    0,
  );
});

// Receiver evidence: subagent-read-content.jsonl holds three real tool results from sessions
// 3e700b2a and 73835409 (content trimmed to 500 characters around the match) where the
// hook-error text sat inside a transcript, a docs page and a log summary the subagent read.
test('hook-error text inside content a subagent read is not counted', () => {
  const read = fileURLToPath(
    new URL('./transcripts/subagent-read-content.jsonl', import.meta.url),
  );
  assert.equal(scan(readFileSync(read, 'utf8')).count, 0);
  const quoted = (content: unknown) =>
    scan(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content }] },
      }),
    ).count;
  assert.equal(quoted('see: PreToolUse:Bash hook error: [x]: no'), 0);
  assert.equal(
    quoted([{ type: 'text', text: 'PreToolUse:Bash hook error: [x]: no' }]),
    1,
  );
});

test('SubagentStop prints nothing, writes the ledger; the next PostToolUse delivers once', () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-errors-'));
  try {
    const stop = run(
      {
        hook_event_name: 'SubagentStop',
        session_id: 's1',
        agent_id: 'a1',
        agent_type: 'krn-lane',
        agent_transcript_path: fixture,
      },
      root,
    );
    assert.equal(stop.status, 0);
    assert.equal(stop.stdout, '');
    const ledger = readFileSync(
      join(root, '.krn', 'runs', 'hook-errors', 'ledger.md'),
      'utf8',
    );
    assert.match(
      ledger,
      /^- subagent krn-lane a1: 1 hook error\(s\): PreToolUse:Bash/u,
    );

    const post = { hook_event_name: 'PostToolUse', session_id: 's1' };
    const other = run({ ...post, session_id: 's2' }, root);
    assert.equal(other.stdout, '');
    const first = JSON.parse(run(post, root).stdout);
    assert.equal(first.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(
      first.hookSpecificOutput.additionalContext,
      /^subagent krn-lane a1: 1 hook error/u,
    );
    assert.equal(run(post, root).stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a clean transcript leaves no ledger and delivers nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-errors-'));
  try {
    const clean = join(root, 'clean.jsonl');
    writeFileSync(clean, '{"type":"user","message":{"content":"hi"}}\n');
    run(
      {
        hook_event_name: 'SubagentStop',
        session_id: 's',
        agent_transcript_path: clean,
      },
      root,
    );
    assert.equal(existsSync(join(root, '.krn')), false);
    mkdirSync(join(root, '.krn'));
    assert.equal(deliver({ session_id: 's' }, root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
