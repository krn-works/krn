import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodexHost, type CodexSessionResult } from '../../src/hosts/codex.ts';
import { requiresIsolation } from '../helpers/isolation.ts';
import {
  SPAWNED_PROCESS_WAIT_MS,
  testTimeoutFor,
} from '../support/process-wait.ts';

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

async function interruptedStream(): Promise<CodexSessionResult> {
  const scratch = join(process.cwd(), '.krn', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'codex-interrupted-'));
  const marker = join(root, 'turn-started');
  let host: CodexHost | undefined;
  try {
    const initialized = spawnSync('git', ['-C', root, 'init', '-q']);
    assert.equal(initialized.status, 0);
    const executable = join(root, 'fake-codex');
    await writeFile(
      executable,
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type:'turn.started'})+'\\n');\nawait import('node:fs/promises').then(({writeFile})=>writeFile(${JSON.stringify(marker)},'started'));\nsetInterval(()=>{},1000);\n`,
      { mode: 0o755 },
    );
    host = new CodexHost({ executable });
    const session = await host.start({
      cwd: root,
      model: 'gpt-6-luna',
      prompt: 'interrupted usage',
      limits: { timeoutMs: 5000 },
    });
    const until = Date.now() + SPAWNED_PROCESS_WAIT_MS;
    while (Date.now() < until) {
      try {
        await access(marker);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    await access(marker);
    await host.cancelAll();
    return await session.wait();
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
      cachedInputTokens: 4,
      cacheWriteInputTokens: 2,
      reasoningOutputTokens: 1,
      outputTokens: 3,
      totalTokens: 15,
    });
  });
});

test('Codex usage retains validation before adding protocol counts', async (t) => {
  if (!requiresIsolation(t, 'Codex invalid usage', ['systemdUserScope']))
    return;
  const invalid = [-1, 0.5, '12', null, Number.MAX_SAFE_INTEGER + 1];
  const lines = invalid
    .flatMap((value) => [
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: value, output_tokens: 2 },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 3, output_tokens: value },
      }),
    ])
    .concat([
      JSON.stringify({ type: 'turn.completed' }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
    ]);
  await runStream(lines, async (result) => {
    assert.deepEqual(result.usage, {
      inputTokens: 15,
      outputTokens: 10,
      totalTokens: 25,
    });
    assert.deepEqual(Reflect.get(result, 'usageObservation'), {
      turnsStarted: 0,
      turnsCompleted: 12,
      invalidFields: 10,
      missingRequiredTurns: 12,
      reportedFields: ['outputTokens', 'inputTokens'],
    });
  });
});

test('started native turn interrupted before completion remains unmeasured', {
  timeout: testTimeoutFor(1),
}, async (t) => {
  if (
    !requiresIsolation(t, 'Codex interrupted usage observation', [
      'systemdUserScope',
    ])
  )
    return;
  const result = await interruptedStream();
  assert.deepEqual(Reflect.get(result, 'usageObservation'), {
    turnsStarted: 1,
    turnsCompleted: 0,
    invalidFields: 0,
    missingRequiredTurns: 0,
    reportedFields: [],
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
