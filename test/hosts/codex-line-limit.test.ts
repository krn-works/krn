import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodexHost, type CodexSessionResult } from '../../src/hosts/codex.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

const lineLimit = 256 * 1024;

async function runStream(stream: string): Promise<CodexSessionResult> {
  const root = await mkdtemp(join(tmpdir(), 'krn-codex-line-limit-'));
  let host: CodexHost | undefined;
  try {
    const initialized = spawnSync('git', ['-C', root, 'init', '-q']);
    assert.equal(initialized.status, 0);
    const executable = join(root, 'fake-codex');
    await writeFile(
      executable,
      `#!/usr/bin/env node
const stream = ${JSON.stringify(stream)};
const chunkSize = 8192;
function writeNext(offset) {
  if (offset >= stream.length) return process.stdout.end();
  const chunk = stream.slice(offset, offset + chunkSize);
  const next = () => writeNext(offset + chunk.length);
  if (!process.stdout.write(chunk)) process.stdout.once('drain', next);
  else setImmediate(next);
}
writeNext(0);
`,
      { mode: 0o755 },
    );
    const previousIsolation = process.env.KRN_ISOLATION;
    process.env.KRN_ISOLATION = 'pid_namespace';
    host = new CodexHost({ executable });
    try {
      const session = await host.start({
        cwd: root,
        model: 'gpt-6-luna',
        prompt: 'synthetic line-limit stream',
        limits: { timeoutMs: 5000 },
      });
      return await session.wait();
    } finally {
      if (previousIsolation === undefined) delete process.env.KRN_ISOLATION;
      else process.env.KRN_ISOLATION = previousIsolation;
    }
  } finally {
    try {
      await host?.cancelAll();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

function eventLine(event: unknown): string {
  return JSON.stringify(event);
}

const finalLines = [
  eventLine({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'normal final message' },
  }),
  eventLine({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 2 },
  }),
].join('\n');

test('a large Codex tool event is skipped and a streamed final message completes', async (t) => {
  if (!requiresIsolation(t, 'Codex oversized tool event', ['bwrap'])) return;

  const oversizedToolEvent = eventLine({
    type: 'item.completed',
    item: { type: 'tool_output', text: 'x'.repeat(1024 * 1024) },
  });
  let largestMeasuredString = 0;
  const originalByteLength = Buffer.byteLength;
  Buffer.byteLength = ((value: string | NodeJS.ArrayBufferView, ...args) => {
    if (typeof value === 'string')
      largestMeasuredString = Math.max(largestMeasuredString, value.length);
    return originalByteLength(value, ...args);
  }) as typeof Buffer.byteLength;
  try {
    const result = await runStream(`${oversizedToolEvent}\n${finalLines}\n`);
    assert.equal(result.reasonKind, 'agent_message');
    assert.equal(result.finalMessage, 'normal final message');
    assert.equal(result.claimsDone, true);
    assert.ok(
      largestMeasuredString <= lineLimit,
      `Codex line buffer exceeded ${lineLimit} bytes: observed ${largestMeasuredString}`,
    );
  } finally {
    Buffer.byteLength = originalByteLength;
  }
});

test('oversized Codex lines before and after a final message do not invalidate it', async (t) => {
  if (!requiresIsolation(t, 'several Codex oversized lines', ['bwrap'])) return;
  const oversized = eventLine({
    type: 'item.completed',
    item: { type: 'tool_output', text: 'y'.repeat(lineLimit + 4096) },
  });
  const result = await runStream(`${oversized}\n${finalLines}\n${oversized}\n`);
  assert.equal(result.reasonKind, 'agent_message');
  assert.equal(result.finalMessage, 'normal final message');
  assert.equal(result.claimsDone, true);
});

test('a trailing oversized Codex event does not invalidate a final message', async (t) => {
  if (!requiresIsolation(t, 'trailing Codex oversized event', ['bwrap']))
    return;
  const oversizedToolEvent = eventLine({
    type: 'item.completed',
    item: { type: 'tool_output', text: 't'.repeat(1024 * 1024) },
  });
  const result = await runStream(`${finalLines}\n${oversizedToolEvent}\n`);
  assert.equal(result.reasonKind, 'agent_message');
  assert.equal(result.finalMessage, 'normal final message');
  assert.equal(result.claimsDone, true);
});

test('an oversized final Codex agent message remains incomplete', async (t) => {
  if (!requiresIsolation(t, 'Codex oversized final message', ['bwrap'])) return;
  const oversizedFinal = eventLine({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'z'.repeat(1024 * 1024) },
  });
  const result = await runStream(
    `${oversizedFinal}\n${eventLine({ type: 'turn.completed' })}\n`,
  );
  assert.equal(result.reasonKind, 'line_limit');
  assert.equal(result.finalMessage, undefined);
  assert.equal(result.claimsDone, false);
});

test('oversized Codex lines without a final message remain incomplete', async (t) => {
  if (!requiresIsolation(t, 'Codex oversized lines without final', ['bwrap']))
    return;
  const oversizedToolEvent = eventLine({
    type: 'item.completed',
    item: { type: 'tool_output', text: 'n'.repeat(1024 * 1024) },
  });
  const result = await runStream(
    `${oversizedToolEvent}\n${oversizedToolEvent}\n`,
  );
  assert.equal(result.reasonKind, 'line_limit');
  assert.equal(result.finalMessage, undefined);
  assert.equal(result.claimsDone, false);
});

test('a malformed short Codex JSONL line keeps its malformed reason', async (t) => {
  if (!requiresIsolation(t, 'malformed short Codex JSONL', ['bwrap'])) return;
  const result = await runStream('{"type":}\n');
  assert.equal(result.reasonKind, 'malformed_jsonl');
});
