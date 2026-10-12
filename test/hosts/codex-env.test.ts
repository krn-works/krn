import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { probeIsolationCapabilities } from '../../scripts/probe-isolation.mjs';
import { CodexHost } from '../../src/hosts/codex.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

test('Codex worker does not receive board credentials', async (t) => {
  if (!process.env.KRN_ISOLATION_CAPABILITIES)
    process.env.KRN_ISOLATION_CAPABILITIES = JSON.stringify(
      probeIsolationCapabilities(),
    );
  if (
    !requiresIsolation(t, 'Codex worker does not receive board credentials', [
      'systemdUserScope',
    ])
  )
    return;

  const directory = await mkdtemp(join(tmpdir(), 'krn-codex-env-'));
  const envFile = join(directory, 'worker-env.json');
  const executable = join(directory, 'fake-codex');
  const previous = {
    KRN_PAPERCLIP_TOKEN: process.env.KRN_PAPERCLIP_TOKEN,
    PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY,
  };
  process.env.KRN_PAPERCLIP_TOKEN = 'sentinel-token';
  process.env.PAPERCLIP_API_KEY = 'sentinel-key';
  try {
    await writeFile(
      executable,
      `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));\nprocess.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ready' } }) + '\\n');\nprocess.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }) + '\\n');\n`,
    );
    await chmod(executable, 0o755);
    const host = new CodexHost({ executable });
    const session = await host.start({
      cwd: directory,
      model: 'gpt-6-luna',
      prompt: 'Run pwd',
      limits: { timeoutMs: 5000 },
    });
    const result = await session.wait();
    const workerEnv = JSON.parse(await readFile(envFile, 'utf8')) as Record<
      string,
      string
    >;
    assert.equal(workerEnv.KRN_PAPERCLIP_TOKEN, undefined);
    assert.equal(workerEnv.PAPERCLIP_API_KEY, undefined);
    assert.ok(workerEnv.HOME);
    assert.ok(workerEnv.PATH);
    assert.equal(result.finalMessage, 'ready');
  } finally {
    if (previous.KRN_PAPERCLIP_TOKEN === undefined)
      delete process.env.KRN_PAPERCLIP_TOKEN;
    else process.env.KRN_PAPERCLIP_TOKEN = previous.KRN_PAPERCLIP_TOKEN;
    if (previous.PAPERCLIP_API_KEY === undefined)
      delete process.env.PAPERCLIP_API_KEY;
    else process.env.PAPERCLIP_API_KEY = previous.PAPERCLIP_API_KEY;
    await rm(directory, { recursive: true, force: true });
  }
});
