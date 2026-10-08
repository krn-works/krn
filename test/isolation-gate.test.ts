import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  countIsolationSkips,
  decideIsolation,
  type IsolationCapabilities,
  isolationSummary,
  postGateStatusWhenClean,
  testSuiteExitCode,
} from '../scripts/isolation-gate.mjs';

const unavailable: IsolationCapabilities = {
  bwrap: { available: false, reason: 'user namespaces are unavailable' },
  systemdUserScope: {
    available: false,
    reason: 'the user manager is unavailable',
  },
};

test('missing isolation in CI produces named skips and a skip summary', () => {
  const decision = decideIsolation(
    'real verdict check',
    ['bwrap', 'systemdUserScope'],
    unavailable,
    true,
  );
  assert.deepEqual(decision, {
    kind: 'skip',
    line: 'SKIP(isolation): real verdict check — missing bwrap user namespaces, systemd user scopes',
  });
  assert.equal(isolationSummary(2), 'Isolation-dependent tests skipped: 2');
  assert.equal(
    countIsolationSkips(
      '# SKIP(isolation): real verdict check — missing bwrap user namespaces\n',
    ),
    1,
  );
  assert.equal(testSuiteExitCode(0, 2, false), 0);
});

test('missing isolation outside CI is a failure decision', () => {
  assert.deepEqual(
    decideIsolation(
      'real verdict check',
      ['systemdUserScope'],
      unavailable,
      false,
    ),
    {
      kind: 'fail',
      message:
        'Isolation requirements failed for real verdict check: missing systemd user scopes',
    },
  );
  assert.equal(testSuiteExitCode(0, 0, false), 0);
});

test('requiresIsolation logs a named CI skip and fails when CI is absent', async () => {
  const tempRoot = join(process.cwd(), 'test');
  const directory = await mkdtemp(join(tempRoot, 'isolation-helper-'));
  const fixture = join(directory, 'requires-isolation.test.mjs');
  const helperUrl = new URL('./helpers/isolation.ts', import.meta.url).href;
  await writeFile(
    fixture,
    `import { test } from 'node:test';\nimport { requiresIsolation } from ${JSON.stringify(helperUrl)};\ntest('rootless fixture', (t) => { if (!requiresIsolation(t, 'rootless fixture', ['systemdUserScope'])) return; throw new Error('missing systemd capability was used'); });\n`,
  );

  const baseEnv = { ...process.env };
  delete baseEnv.CI;
  delete baseEnv.NODE_TEST_CONTEXT;
  const capabilities = JSON.stringify(unavailable);
  try {
    const ciRun = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', fixture],
      {
        encoding: 'utf8',
        env: {
          ...baseEnv,
          CI: 'true',
          KRN_ISOLATION_CAPABILITIES: capabilities,
        },
      },
    );
    assert.equal(
      ciRun.status,
      0,
      JSON.stringify({ error: ciRun.error?.message, stderr: ciRun.stderr }),
    );
    assert.notEqual(
      ciRun.stdout,
      '',
      JSON.stringify({
        status: ciRun.status,
        error: ciRun.error?.message,
        signal: ciRun.signal,
        stderr: ciRun.stderr,
      }),
    );
    assert.match(
      ciRun.stdout,
      /SKIP\(isolation\): rootless fixture — missing systemd user scopes/u,
    );
    assert.match(ciRun.stdout, /^# skipped 1$/mu);
    assert.equal(countIsolationSkips(ciRun.stdout), 1);

    const localRun = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', fixture],
      {
        encoding: 'utf8',
        env: { ...baseEnv, KRN_ISOLATION_CAPABILITIES: capabilities },
      },
    );
    assert.equal(localRun.status, 1, localRun.stdout);
    assert.match(
      localRun.stdout,
      /Isolation requirements failed for rootless fixture: missing systemd user scopes/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const [signal, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const) {
  test(`${signal} of the test-suite wrapper stops its sleeping test child`, async () => {
    await assertTestSuiteSignal(signal, exitCode);
  });
}

async function assertTestSuiteSignal(
  signal: NodeJS.Signals,
  expectedExitCode: number,
): Promise<void> {
  const directory = await mkdtemp(join(process.cwd(), 'test/wrapper-signal-'));
  const fixture = join(directory, 'sleeping.test.mjs');
  const pidFile = join(directory, 'child.pid');
  const wrapper = new URL('../scripts/test-suite.mjs', import.meta.url)
    .pathname;
  await writeFile(
    fixture,
    `import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nimport { test } from 'node:test';\ntest('sleeping test', async () => { const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); writeFileSync(${JSON.stringify(pidFile)}, String(sleeper.pid)); await new Promise(() => {}); });\n`,
  );

  let output = '';
  let errors = '';
  let wrapperProcess: ReturnType<typeof spawn> | undefined;
  let wrapperPid: number | undefined;
  let testRunnerPid: number | undefined;
  let sleepingPid: number | undefined;
  try {
    const wrapperEnv = { ...process.env };
    delete wrapperEnv.NODE_TEST_CONTEXT;
    const runningWrapper = spawn(process.execPath, [wrapper, fixture], {
      cwd: process.cwd(),
      detached: true,
      env: wrapperEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    wrapperProcess = runningWrapper;
    assert.ok(runningWrapper.stdout);
    assert.ok(runningWrapper.stderr);
    runningWrapper.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
    });
    runningWrapper.stderr.setEncoding('utf8').on('data', (chunk) => {
      errors += chunk;
    });
    sleepingPid = await waitForFile(pidFile);
    wrapperPid = wrapperProcess.pid;
    assert.ok(wrapperPid);
    testRunnerPid = await waitForChildProcess(wrapperPid);
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) =>
      runningWrapper.once('exit', (code, signal) => resolve({ code, signal })),
    );
    process.kill(wrapperPid, signal);
    const result = await exited;
    await waitForProcessExit(sleepingPid);
    assert.deepEqual(
      {
        exitCode: result.code,
        signal: result.signal,
        sleepingChildAlive: processIsAlive(sleepingPid),
      },
      {
        exitCode: expectedExitCode,
        signal: null,
        sleepingChildAlive: false,
      },
      `${output}\n${errors}`,
    );
  } finally {
    if (wrapperPid !== undefined) killProcessGroup(wrapperPid);
    if (testRunnerPid !== undefined) killProcessGroup(testRunnerPid);
    if (
      wrapperProcess?.exitCode === null &&
      wrapperProcess.signalCode === null
    ) {
      wrapperProcess.kill('SIGKILL');
      await new Promise<void>((resolve) =>
        wrapperProcess?.once('close', () => resolve()),
      );
    }
    if (sleepingPid !== undefined && processIsAlive(sleepingPid)) {
      try {
        process.kill(sleepingPid, 'SIGKILL');
      } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test('gate-local refuses to post a status when any isolation test was skipped', async () => {
  let posted = false;
  const accepted = await postGateStatusWhenClean({
    exitCode: 0,
    skipCount: 1,
    post: () => {
      posted = true;
    },
  });
  assert.equal(accepted, false);
  assert.equal(posted, false);
  assert.equal(testSuiteExitCode(0, 1, true), 1);

  const failedGate = await postGateStatusWhenClean({
    exitCode: 1,
    skipCount: 0,
    post: () => {
      posted = true;
    },
  });
  assert.equal(failedGate, false);
  assert.equal(posted, false);
});

async function waitForFile(path: string): Promise<number> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      return Number((await readFile(path, 'utf8')).trim());
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.fail(`timed out waiting for sleeping test pid file ${path}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && processIsAlive(pid))
    await new Promise((resolve) => setTimeout(resolve, 20));
}

async function waitForChildProcess(parentPid: number): Promise<number> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = spawnSync(
      'ps',
      ['-o', 'pid=', '--ppid', String(parentPid)],
      {
        encoding: 'utf8',
      },
    );
    const pid = Number(result.stdout.trim().split(/\s+/u)[0]);
    if (Number.isInteger(pid) && pid > 0) return pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for test runner child of ${parentPid}`);
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {}
}

function processIsAlive(pid: number): boolean {
  try {
    const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
    });
    return stat.status === 0 && !stat.stdout.trim().startsWith('Z');
  } catch {
    return false;
  }
}
