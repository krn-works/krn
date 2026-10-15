import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { stateDirectory } from '../../src/foreman/state.ts';
import { CodexHost, type CodexSessionResult } from '../../src/hosts/codex.ts';
import * as trace from '../../src/trace/index.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

// Synthetic complete ThreadEvent/Usage shapes from Codex rust-v0.162.1:
// https://github.com/openai/codex/blob/rust-v0.162.1/sdk/typescript/src/events.ts
// Vendor events.ts blob: f6ad902779bee05ab0fb9b9cc6a2bca59d52c136.
// Cached, cache-write and reasoning tokens are subsets, never extra usage.
const fixture = (
  await readFile(
    new URL('../fixtures/codex/rust-v0.162.1.jsonl', import.meta.url),
    'utf8',
  )
)
  .trim()
  .split('\n');

async function runStream(
  lines: readonly string[],
  inspect: (result: CodexSessionResult, root: string) => Promise<void>,
): Promise<void> {
  const scratch = join(process.cwd(), '.krn', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'codex-usage-'));
  let host: CodexHost | undefined;
  try {
    const initialized = spawnSync('git', ['-C', root, 'init', '-q']);
    assert.equal(initialized.status, 0);
    const executable = join(root, 'fake-codex');
    const stream = `${lines.join('\n')}\n`;
    await writeFile(
      executable,
      `#!/usr/bin/env node
const stream = ${JSON.stringify(stream)};
// Split JSONL records across writes, exercising the real adapter's buffer too.
process.stdout.write(stream.slice(0, 37));
setImmediate(() => process.stdout.write(stream.slice(37)));
`,
      { mode: 0o755 },
    );
    host = new CodexHost({ executable });
    const session = await host.start({
      cwd: root,
      model: 'gpt-6-luna',
      prompt: 'synthetic usage',
      limits: { timeoutMs: 5000 },
    });
    const result = await session.wait();
    assert.equal(result.exitCode, 0);
    await inspect(result, root);
  } finally {
    try {
      await host?.cancelAll();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

test('Codex protocol input12 output3 cached4 accounts for exactly15 tokens', async (t) => {
  if (!requiresIsolation(t, 'Codex protocol usage', ['systemdUserScope']))
    return;
  await runStream(fixture.slice(0, 4), async (result) => {
    assert.deepEqual(result.usage, {
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
    });
  });
});

test('Codex multiple turns accumulate usage and preserve totals in trace', async (t) => {
  if (!requiresIsolation(t, 'Codex multi-turn usage', ['systemdUserScope']))
    return;
  await runStream(fixture, async (result, root) => {
    assert.deepEqual(result.usage, {
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
    });
    const job = {
      id: 'usage-fixture',
      issue: 'fixture',
      worktree: root,
      repoRoot: root,
    };
    await trace.log(
      job,
      'usage-intent',
      result.sessionId,
      'session_ended',
      result,
    );
    const event = JSON.parse(
      (await readFile(join(stateDirectory(job), 'trace.jsonl'), 'utf8')).trim(),
    );
    assert.deepEqual(event.data.end.usage, {
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
    });
  });
});

test('Codex usage retains validation before adding protocol counts', async (t) => {
  if (!requiresIsolation(t, 'Codex invalid usage', ['systemdUserScope']))
    return;
  const invalid = [-1, 0.5, '12', null, Number.MAX_SAFE_INTEGER + 1];
  const lines = invalid.flatMap((value) => [
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: value, output_tokens: 2 },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 3, output_tokens: value },
    }),
  ]);
  await runStream(lines, async (result) => {
    assert.deepEqual(result.usage, {
      inputTokens: 15,
      outputTokens: 10,
      totalTokens: 25,
    });
  });
});

test('Codex usage saturates both per-turn and accumulated token sums safely', async (t) => {
  if (!requiresIsolation(t, 'Codex saturated usage', ['systemdUserScope']))
    return;
  const lines = [
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 2 },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 1, output_tokens: Number.MAX_SAFE_INTEGER },
    }),
  ];
  await runStream(lines, async (result) => {
    assert.deepEqual(result.usage, {
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: Number.MAX_SAFE_INTEGER,
      totalTokens: Number.MAX_SAFE_INTEGER,
    });
  });
});
