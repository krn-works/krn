import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { countLines, countSession } from '../../evals/d23/transcript.ts';

// Evidence: four lines copied verbatim (host paths replaced) from a D23 K session transcript (dev-k1 unit 568):
// a silent piped-check hook_success, the SessionStart hook_additional_context, an assistant tool_use, a non-blocking stop_hook_summary.
const capture = fileURLToPath(
  new URL('../fixtures/d23-transcript/session.jsonl', import.meta.url),
);

test('only hook records the model reads count as hook messages', () => {
  const root = mkdtempSync(join(tmpdir(), 'd23-transcript-'));
  try {
    copyFileSync(capture, join(root, 'sid-a.jsonl'));
    assert.deepEqual(countSession(root, 'sid-a'), {
      toolCalls: 1,
      hookEvents: 3,
      hookMsgs: 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('other sessions sharing the project directory are not counted, subagent transcripts are', () => {
  const root = mkdtempSync(join(tmpdir(), 'd23-transcript-'));
  try {
    copyFileSync(capture, join(root, 'sid-a.jsonl'));
    copyFileSync(capture, join(root, 'sid-old.jsonl'));
    mkdirSync(join(root, 'sid-a', 'subagents'), { recursive: true });
    copyFileSync(capture, join(root, 'sid-a', 'subagents', 'agent-1.jsonl'));
    assert.deepEqual(countSession(root, 'sid-a'), {
      toolCalls: 2,
      hookEvents: 6,
      hookMsgs: 2,
    });
    assert.deepEqual(countSession(root, ''), {
      toolCalls: 0,
      hookEvents: 0,
      hookMsgs: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stop summary that blocked or reported errors reaches the model', () => {
  const line = (extra: object) =>
    JSON.stringify({
      type: 'system',
      subtype: 'stop_hook_summary',
      hookErrors: [],
      preventedContinuation: false,
      ...extra,
    });
  assert.equal(countLines([line({})]).hookMsgs, 0);
  assert.equal(countLines([line({ preventedContinuation: true })]).hookMsgs, 1);
  assert.equal(countLines([line({ hookErrors: ['no commit'] })]).hookMsgs, 1);
  assert.equal(countLines(['not json', '']).hookEvents, 0);
});
