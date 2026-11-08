import assert from 'node:assert/strict';
import test from 'node:test';
import { fitEnvelope } from '../../scripts/claude/context-restart.ts';
import { cutText } from '../../scripts/claude/cut-text.ts';
import { resumeBlock } from '../../scripts/claude/handoff-resume.ts';
import {
  inboxText,
  maxText,
  oneLine,
} from '../../scripts/claude/operator-inbox-store.ts';
import { bounded } from '../../scripts/codex/context-hook.ts';

// Every bound in a run of consecutive limits lands inside some astral
// character, so a UTF-16 slice would leave a lone surrogate at one of them.
const emoji = '😀';
const limits = (from: number) =>
  Array.from({ length: 6 }, (_, index) => from + index);
const wellFormed = (value: string) =>
  assert.ok(value.isWellFormed(), `lone surrogate in ${JSON.stringify(value)}`);

test('cutText keeps astral characters whole within the bound', () => {
  const text = `a${emoji.repeat(50)}`;
  for (const limit of limits(20)) {
    const cut = cutText(text, limit);
    wellFormed(cut);
    assert.ok(cut.length <= limit && cut.length >= limit - 1);
  }
  assert.equal(cutText(text, 500), text);
  const bytes = (value: string) => Buffer.byteLength(value);
  for (const limit of limits(30)) {
    const cut = cutText(text, limit, bytes);
    wellFormed(cut);
    assert.ok(bytes(cut) <= limit && bytes(cut) > limit - 4);
  }
});

test('resumeBlock cuts the handoff block on code points', () => {
  const handoff = `## Resume\n- Task: ${emoji.repeat(200)}\n`;
  for (const limit of limits(80)) {
    const block = resumeBlock(handoff, limit);
    assert.ok(block);
    wellFormed(block);
    assert.ok(block.length <= limit);
  }
});

test('codex bounded cuts the restart block on code points within its bytes', () => {
  for (const pad of [8, 9]) {
    const out = bounded(
      'SessionStart',
      `${'a'.repeat(pad)}${emoji.repeat(3000)}b`,
    );
    wellFormed(out);
    assert.match(out, /\[truncated: /u);
    const envelope = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: out,
      },
    });
    assert.ok(Buffer.byteLength(envelope) <= 4096);
  }
});

test('fitEnvelope cuts the Claude restart context on code points', () => {
  const text = `x${emoji.repeat(500)}`;
  for (const limit of limits(300)) {
    const out = fitEnvelope('SessionStart', text, limit);
    wellFormed(out);
    const size = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: out,
      },
    }).length;
    assert.ok(size <= limit && size >= limit - 1);
  }
});

test('operator inbox text and one-line views cut on code points', () => {
  for (const pad of [0, 1]) {
    const stored = inboxText(`${'p'.repeat(pad)}${emoji.repeat(maxText)}`);
    wellFormed(stored);
    assert.ok(stored.length <= maxText && stored.length >= maxText - 1);
  }
  const prompt = `one\n${emoji.repeat(120)}`;
  for (const limit of [...limits(100), ...limits(160)]) {
    const line = oneLine(prompt, limit);
    wellFormed(line);
    assert.ok(line.length <= limit);
  }
});
