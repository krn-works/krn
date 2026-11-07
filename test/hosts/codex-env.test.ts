import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodexHost } from '../../src/hosts/codex.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

type IsolationCapabilityProbe = {
  available: boolean;
  reason: string;
};

type ProbeIsolationModule = {
  probeIsolationCapabilities: () => {
    bwrap: IsolationCapabilityProbe;
    systemdUserScope: IsolationCapabilityProbe;
  };
};

const require = createRequire(import.meta.url);
const { probeIsolationCapabilities } =
  require('../../scripts/probe-isolation.mjs') as ProbeIsolationModule;

test('Codex worker does not receive service credentials', async (t) => {
  if (!process.env.KRN_ISOLATION_CAPABILITIES)
    process.env.KRN_ISOLATION_CAPABILITIES = JSON.stringify(
      probeIsolationCapabilities(),
    );
  if (
    !requiresIsolation(t, 'Codex worker does not receive service credentials', [
      'systemdUserScope',
    ])
  )
    return;

  const directory = await mkdtemp(join(tmpdir(), 'krn-codex-env-'));
  const envFile = join(directory, 'worker-env.json');
  const executable = join(directory, 'fake-codex');
  const previous = {
    KRN_SERVICE_TOKEN: process.env.KRN_SERVICE_TOKEN,
    SERVICE_API_KEY: process.env.SERVICE_API_KEY,
  };
  process.env.KRN_SERVICE_TOKEN = 'sentinel-token';
  process.env.SERVICE_API_KEY = 'sentinel-key';
  try {
    await writeFile(
      executable,
      `#!/usr/bin/env node\nawait new Promise((done) => { process.stdin.on("end", done); process.stdin.resume(); });\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));\nprocess.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ready' } }) + '\\n');\nprocess.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }) + '\\n');\n`,
    );
    await chmod(executable, 0o755);
    const host = new CodexHost({ executable, drainQuietMs: 100 });
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
    assert.equal(workerEnv.KRN_SERVICE_TOKEN, undefined);
    assert.equal(workerEnv.SERVICE_API_KEY, undefined);
    assert.ok(workerEnv.HOME);
    assert.ok(workerEnv.PATH);
    assert.equal(result.finalMessage, 'ready');
  } finally {
    if (previous.KRN_SERVICE_TOKEN === undefined)
      delete process.env.KRN_SERVICE_TOKEN;
    else process.env.KRN_SERVICE_TOKEN = previous.KRN_SERVICE_TOKEN;
    if (previous.SERVICE_API_KEY === undefined)
      delete process.env.SERVICE_API_KEY;
    else process.env.SERVICE_API_KEY = previous.SERVICE_API_KEY;
    await rm(directory, { recursive: true, force: true });
  }
});
