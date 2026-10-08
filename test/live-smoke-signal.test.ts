import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const repoRoot = resolve(import.meta.dirname, '..');
const smokeScript = join(repoRoot, 'scripts/live-smoke.mjs');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`live smoke cleans up its session and repo on ${signal}`, async () => {
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

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5000;
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
