import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {
  captureFixture,
  captureFixtureLine,
  HOST_PATH_PLACEHOLDER,
} from '../../scripts/claude/capture-fixture.ts';

const fixtures = new URL('fixtures/', import.meta.url);
const slash = String.fromCharCode(47);
const hostRoot = `${slash}home${slash}krn${slash}project`;

test('capture elides message content, resets cwd and redacts host paths', () => {
  const line = JSON.stringify({
    type: 'assistant',
    cwd: hostRoot,
    message: { role: 'assistant', content: [{ type: 'text', text: 'secret' }] },
    note: `see ${hostRoot}/file.ts now`,
  });
  assert.equal(
    captureFixtureLine(line),
    `{"type": "assistant", "cwd": ".", "message": {"role": "assistant", "content": []}, "note": "see ${HOST_PATH_PLACEHOLDER} now"}`,
  );
});

test('capture elides tool inputs and outputs repeated outside the message', () => {
  const line = JSON.stringify({
    type: 'user',
    toolUseResult: { stdout: 'secret' },
    wireToolInputs: { toolu_1: { command: 'secret' } },
  });
  assert.equal(
    captureFixtureLine(line),
    '{"type": "user", "toolUseResult": {}, "wireToolInputs": {}}',
  );
});

test('capture keeps non-ASCII escaped like the harness transcript', () => {
  assert.equal(
    captureFixtureLine('{"a":"z\\u00f3\\u0142w"}'),
    '{"a": "z\\u00f3\\u0142w"}',
  );
});

for (const name of readdirSync(fixtures).filter((file) =>
  file.endsWith('.jsonl'),
))
  test(`fixture ${name} is unchanged by capture`, () => {
    const text = readFileSync(new URL(name, fixtures), 'utf8');
    assert.equal(captureFixture(text), text);
  });
