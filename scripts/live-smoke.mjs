import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexHost } from '../src/hosts/codex.ts';

if (process.env.KRN_LIVE !== '1') {
  process.stderr.write('Set KRN_LIVE=1 to run the live Codex smoke check.\n');
  process.exit(2);
}

const cwd = await mkdtemp(join(tmpdir(), 'krn-codex-live-smoke-'));
try {
  const initialized = spawnSync('git', ['-C', cwd, 'init', '-q']);
  assert.equal(initialized.status, 0, 'could not initialize the smoke repo');

  const host = new CodexHost();
  const session = await host.start({
    cwd,
    model: 'gpt-6-luna',
    prompt: 'Run the shell command pwd and reply with its output only',
    limits: { timeoutMs: 145_000 },
  });
  const result = await session.wait();
  assert.equal(result.claimsDone, true, 'Codex did not finish successfully');
  assert.ok(
    result.finalMessage?.includes(cwd),
    `Expected final message to contain ${cwd}, got ${JSON.stringify(result.finalMessage)}`,
  );
  process.stdout.write(`Live Codex smoke passed: ${result.finalMessage}\n`);
} finally {
  await rm(cwd, { recursive: true, force: true });
}
