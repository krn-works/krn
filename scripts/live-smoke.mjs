import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexHost, defaultCodexExecutable } from '../src/hosts/codex.ts';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.env.KRN_LIVE !== '1') {
  process.stderr.write('Set KRN_LIVE=1 to run the live Codex smoke check.\n');
  process.exit(2);
}

await runLiveSmoke();

async function runLiveSmoke() {
  const executable =
    process.env.KRN_LIVE_CODEX_EXECUTABLE ?? defaultCodexExecutable;
  const tmpRoot = join(repositoryRoot, '.krn', 'tmp');
  await mkdir(tmpRoot, { recursive: true });
  const cwd = await mkdtemp(join(tmpRoot, 'krn-codex-live-smoke-'));
  const host = new CodexHost({ executable });
  let session;
  let terminationSignal;
  let cancellation;
  let sessionReady = false;
  let signaledBeforeSession = false;
  const handleSignal = (signal) => {
    if (terminationSignal) return;
    terminationSignal = signal;
    if (!sessionReady) signaledBeforeSession = true;
    cancellation = host.cancelAll();
  };
  const onSigterm = () => handleSignal('SIGTERM');
  const onSigint = () => handleSignal('SIGINT');
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  try {
    const initialized = spawnSync('git', ['-C', cwd, 'init', '-q']);
    assert.equal(initialized.status, 0, 'could not initialize the smoke repo');

    session = await host.start({
      cwd,
      model: 'gpt-6-luna',
      prompt: 'Run the shell command pwd and reply with its output only',
      limits: { timeoutMs: 145_000 },
    });
    sessionReady = true;
    if (signaledBeforeSession) cancellation = host.cancelAll();
    const result = await session.wait();
    if (terminationSignal) {
      await cancellation;
      process.exitCode = terminationSignal === 'SIGINT' ? 130 : 143;
      return;
    }

    assert.equal(result.claimsDone, true, 'Codex did not finish successfully');
    assert.ok(
      result.finalMessage?.includes(cwd),
      `Expected final message to contain ${cwd}, got ${JSON.stringify(result.finalMessage)}`,
    );
    process.stdout.write(`Live Codex smoke passed: ${result.finalMessage}\n`);
  } finally {
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
    try {
      await host.cancelAll();
      await cancellation;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}
