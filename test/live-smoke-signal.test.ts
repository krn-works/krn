import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { requiresIsolation } from './helpers/isolation.ts';
import {
  SPAWNED_PROCESS_WAIT_MS,
  testTimeoutFor,
} from './support/process-wait.ts';

const repoRoot = resolve(import.meta.dirname, '..');
const smokeScript = join(repoRoot, 'scripts/live-smoke.mjs');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`live smoke cleans up its session and repo on ${signal}`, {
    timeout: testTimeoutFor(1),
  }, async (t) => {
    if (
      !requiresIsolation(
        t,
        `live smoke cleans up its session and repo on ${signal}`,
        ['systemdUserScope'],
      )
    )
      return;
    const fixtureRoot = join(repoRoot, '.krn', 'tmp');
    await mkdir(fixtureRoot, { recursive: true });
    const fixture = await mkdtemp(join(fixtureRoot, 'krn-smoke-signal-test-'));
    const executable = join(fixture, 'fake-codex');
    const cwdFile = join(fixture, 'cwd');
    const pidFile = join(fixture, 'pid');
    await writeFile(
      executable,
      `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nconst args=process.argv.slice(2);\nconst cwd=args[args.indexOf('--cd')+1];\nwriteFileSync(${JSON.stringify(cwdFile)}, cwd);\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.stdin.resume();\nsetInterval(()=>{},1000);\n`,
    );
    await chmod(executable, 0o755);

    let smokeCwd: string | undefined;
    let codexPid: number | undefined;
    let exit:
      | { code: number | null; signal: NodeJS.Signals | null }
      | undefined;
    try {
      const child = spawn(process.execPath, [smokeScript], {
        env: {
          ...process.env,
          KRN_LIVE: '1',
          KRN_LIVE_CODEX_EXECUTABLE: executable,
        },
        stdio: 'ignore',
      });
      await waitFor(async () => {
        try {
          smokeCwd = (await readFile(cwdFile, 'utf8')).trim();
          codexPid = Number((await readFile(pidFile, 'utf8')).trim());
          return true;
        } catch {
          return undefined;
        }
      });
      child.kill(signal);
      exit = await waitForExit(child);
      const orphanRemained = await isAlive(codexPid);
      const leakedTempRepo = await exists(smokeCwd);
      const repoLocalTempRepo = Boolean(
        smokeCwd?.startsWith(join(repoRoot, '.krn', 'tmp') + sep),
      );

      assert.deepEqual(
        { exit, orphanRemained, leakedTempRepo, repoLocalTempRepo },
        {
          exit: { code: signal === 'SIGTERM' ? 143 : 130, signal: null },
          orphanRemained: false,
          leakedTempRepo: false,
          repoLocalTempRepo: true,
        },
      );
    } finally {
      if (codexPid !== undefined && (await isAlive(codexPid)))
        process.kill(codexPid, 'SIGKILL');
      if (smokeCwd) await rm(smokeCwd, { recursive: true, force: true });
      await rm(fixture, { recursive: true, force: true });
    }
  });
}

test('live smoke retains its private fixture and reports it after failure', async (t) => {
  if (
    !requiresIsolation(t, 'live smoke retains failure evidence', [
      'systemdUserScope',
    ])
  )
    return;
  const fixtureRoot = join(repoRoot, '.krn', 'tmp');
  await mkdir(fixtureRoot, { recursive: true });
  const fixture = await mkdtemp(join(fixtureRoot, 'krn-smoke-failure-test-'));
  const executable = join(fixture, 'fake-codex');
  await writeFile(
    executable,
    '#!/bin/sh\necho deliberate-smoke-failure >&2\nexit 9\n',
  );
  await chmod(executable, 0o755);
  try {
    const child = spawn(process.execPath, [smokeScript], {
      env: {
        ...process.env,
        KRN_LIVE: '1',
        KRN_LIVE_CODEX_EXECUTABLE: executable,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const [stdout, stderr, exit] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      waitForExit(child),
    ]);
    assert.notEqual(exit.code, 0);
    const artifact = stderr
      .match(/Failure evidence retained at: (.+)/u)?.[1]
      ?.trim();
    assert.ok(artifact, stderr);
    assert.equal(await exists(artifact), true);
    assert.doesNotMatch(stdout, /Live Codex sandbox checkpoint smoke passed/u);
    const jobId = (
      await readdir(join(artifact, '.krn', 'runs', 'foreman'))
    ).find((name) => name.startsWith('smoke-'));
    assert.ok(jobId);
    assert.match(
      await readFile(
        join(artifact, '.krn', 'runs', 'foreman', jobId, 'trace.jsonl'),
        'utf8',
      ),
      /"kind":"failure"/u,
    );
    assert.match(
      await readFile(join(artifact, 'README.md'), 'utf8'),
      /live checkpoint smoke/u,
    );
    await rm(artifact, { recursive: true, force: true });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + SPAWNED_PROCESS_WAIT_MS;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  }
  assert.fail('timed out waiting for live smoke fake Codex to start');
}

async function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error('live smoke did not exit after the signal'));
    }, 5000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal: signal as NodeJS.Signals | null });
    });
  });
}

async function collect(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return '';
  let value = '';
  for await (const chunk of stream) value += String(chunk);
  return value;
}

async function exists(path: string | undefined): Promise<boolean> {
  if (!path) return false;
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isAlive(pid: number | undefined): Promise<boolean> {
  if (pid === undefined || !Number.isSafeInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
