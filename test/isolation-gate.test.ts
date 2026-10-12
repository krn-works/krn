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
  const wrapper = new URL('../scripts/test-suite.mjs', import.meta.url)
    .pathname;
  await writeFile(
    fixture,
    `import { test } from 'node:test';\nimport { requiresIsolation } from ${JSON.stringify(helperUrl)};\ntest('rootless fixture', (t) => { if (!requiresIsolation(t, 'rootless fixture', ['systemdUserScope'])) return; throw new Error('missing systemd capability was used'); });\n`,
  );

  const baseEnv = { ...process.env };
  delete baseEnv.CI;
  delete baseEnv.NODE_TEST_CONTEXT;
  // This child exercises isolation policy; the host-only strict flag stays outside it.
  delete baseEnv.KRN_REQUIRE_ZERO_ISOLATION_SKIPS;
  const capabilities = JSON.stringify(unavailable);
  try {
    const ciRun = spawnSync(process.execPath, [wrapper, fixture], {
      encoding: 'utf8',
      env: {
        ...baseEnv,
        CI: 'true',
        KRN_SCOPE_PROBE: '1',
        KRN_ISOLATION_CAPABILITIES: capabilities,
      },
    });
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

    const localRun = spawnSync(process.execPath, [wrapper, fixture], {
      encoding: 'utf8',
      env: {
        ...baseEnv,
        KRN_SCOPE_PROBE: '1',
        KRN_ISOLATION_CAPABILITIES: capabilities,
      },
    });
    assert.equal(localRun.status, 1, localRun.stdout);
    assert.match(
      localRun.stdout,
      /Isolation requirements failed for rootless fixture: missing systemd user scopes/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('requiresIsolation accepts a real active CommonJS test context', async () => {
  const directory = await mkdtemp(
    join(process.cwd(), 'test/isolation-cjs-context-'),
  );
  const fixture = join(directory, 'requires-isolation.test.cjs');
  const helperUrl = new URL('./helpers/isolation.ts', import.meta.url).href;
  const wrapper = new URL('../scripts/test-suite.mjs', import.meta.url)
    .pathname;
  const runnerEnv = { ...process.env };
  delete runnerEnv.NODE_TEST_CONTEXT;
  // The host-only strict flag does not apply to this simulated CI runner.
  delete runnerEnv.KRN_REQUIRE_ZERO_ISOLATION_SKIPS;
  runnerEnv.CI = 'true';
  runnerEnv.KRN_SCOPE_PROBE = '1';
  runnerEnv.KRN_ISOLATION_CAPABILITIES = JSON.stringify(unavailable);

  try {
    await writeFile(
      fixture,
      `const { test } = require('node:test');\ntest('rootless CJS fixture', async (t) => { const { requiresIsolation } = await import(${JSON.stringify(helperUrl)}); if (!requiresIsolation(t, 'rootless CJS fixture', ['systemdUserScope'])) return; throw new Error('missing systemd capability was used'); });\n`,
    );
    const run = spawnSync(process.execPath, [wrapper, fixture], {
      encoding: 'utf8',
      env: runnerEnv,
    });

    assert.equal(
      run.status,
      0,
      JSON.stringify({
        error: run.error?.message,
        stderr: run.stderr,
        stdout: run.stdout,
      }),
    );
    assert.equal(countIsolationSkips(run.stdout), 1, run.stdout);
    assert.match(run.stdout, /^# skipped 1$/mu);
    assert.match(
      run.stdout,
      /SKIP\(isolation\): rootless CJS fixture — missing systemd user scopes/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('test-mutated capabilities cannot approve an isolation skip', async () => {
  const directory = await mkdtemp(
    join(process.cwd(), 'test/isolation-env-mutation-'),
  );
  const fixture = join(directory, 'mutates-capabilities.test.mjs');
  const helperUrl = new URL('./helpers/isolation.ts', import.meta.url).href;
  const available: IsolationCapabilities = {
    bwrap: { available: true, reason: 'available in runner' },
    systemdUserScope: { available: true, reason: 'available in runner' },
  };
  const unavailableCapabilities: IsolationCapabilities = {
    bwrap: { available: false, reason: 'mutated by test' },
    systemdUserScope: {
      available: false,
      reason: 'mutated by test',
    },
  };

  try {
    await writeFile(
      fixture,
      `import { test } from 'node:test';\ntest('mutates inherited capabilities', async (t) => { process.env.KRN_ISOLATION_CAPABILITIES = ${JSON.stringify(JSON.stringify(unavailableCapabilities))}; const { requiresIsolation } = await import(${JSON.stringify(helperUrl)}); requiresIsolation(t, 'mutates inherited capabilities', ['systemdUserScope']); });\n`,
    );

    const wrapper = new URL('../scripts/test-suite.mjs', import.meta.url)
      .pathname;
    const runnerEnv = { ...process.env };
    delete runnerEnv.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, [wrapper, fixture], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...runnerEnv,
        CI: 'true',
        KRN_SCOPE_PROBE: '1',
        KRN_ISOLATION_CAPABILITIES: JSON.stringify(available),
      },
    });

    assert.equal(
      run.status,
      0,
      JSON.stringify({ error: run.error?.message, stderr: run.stderr }),
    );
    assert.notEqual(
      run.stdout,
      '',
      JSON.stringify({
        status: run.status,
        error: run.error?.message,
        signal: run.signal,
        stderr: run.stderr,
      }),
    );
    assert.equal(countIsolationSkips(run.stdout), 0, run.stdout);
    assert.match(run.stdout, /^# tests 1$/mu);
    assert.match(run.stdout, /^# skipped 0$/mu);
    assert.match(run.stdout, /Isolation-dependent tests skipped: 0/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CI rejects reason-prefix, fake-context, and stale-context skip attacks', async () => {
  const directory = await mkdtemp(
    join(process.cwd(), 'test/isolation-skip-attacks-'),
  );
  const wrapper = new URL('../scripts/test-suite.mjs', import.meta.url)
    .pathname;
  const helperUrl = new URL('./helpers/isolation.ts', import.meta.url).href;
  const runnerEnv = { ...process.env };
  delete runnerEnv.NODE_TEST_CONTEXT;
  const capabilities = JSON.stringify({
    bwrap: { available: true, reason: 'available in runner' },
    systemdUserScope: { available: true, reason: 'available in runner' },
  });

  const runFixture = async (filename: string, source: string) => {
    const fixture = join(directory, filename);
    await writeFile(fixture, source);
    return spawnSync(process.execPath, [wrapper, fixture], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...runnerEnv,
        CI: 'true',
        KRN_SCOPE_PROBE: '1',
        KRN_ISOLATION_CAPABILITIES: capabilities,
      },
    });
  };

  try {
    const reasonPrefixRun = await runFixture(
      'reason-prefix.test.mjs',
      `import { test } from 'node:test';\nimport { requiresIsolation } from ${JSON.stringify(helperUrl)};\nif (false) requiresIsolation(undefined, 'ordinary skip', []);\ntest('ordinary skip', (t) => t.skip('SKIP(isolation): forged without executing requiresIsolation'));\n`,
    );
    assert.equal(reasonPrefixRun.status, 1, reasonPrefixRun.stdout);
    assert.match(reasonPrefixRun.stdout, /UNAPPROVED_TEST_SKIP:/u);
    assert.match(
      reasonPrefixRun.stderr,
      /test called skip outside requiresIsolation/u,
    );

    const ordinarySkipRun = await runFixture(
      'ordinary-skip.test.mjs',
      `import { test } from 'node:test';\ntest('ordinary skip', (t) => t.skip('not an isolation skip'));\n`,
    );
    assert.equal(ordinarySkipRun.status, 1, ordinarySkipRun.stdout);
    assert.match(ordinarySkipRun.stdout, /UNAPPROVED_TEST_SKIP:/u);
    assert.match(
      ordinarySkipRun.stderr,
      /runner reported 1 skipped tests but 0 isolation approvals/u,
    );

    const fakeContextRun = await runFixture(
      'fake-context.test.mjs',
      `import { test } from 'node:test';\nimport { requiresIsolation } from ${JSON.stringify(helperUrl)};\ntest('ordinary skip', (t) => { let reason; const fakeContext = { skip(value) { reason = value; } }; requiresIsolation(fakeContext, 'ordinary skip', ['systemdUserScope']); t.skip(reason); });\n`,
    );
    assert.equal(fakeContextRun.status, 1, fakeContextRun.stdout);
    assert.match(
      fakeContextRun.stdout,
      /requiresIsolation must receive the active test context/u,
    );

    const staleContextRun = await runFixture(
      'stale-context.test.mjs',
      `import { test } from 'node:test';\nimport { requiresIsolation } from ${JSON.stringify(helperUrl)};\nlet staleContext;\ntest('capture context', (t) => { staleContext = t; });\ntest('use stale context', () => requiresIsolation(staleContext, 'use stale context', ['systemdUserScope']));\n`,
    );
    assert.equal(staleContextRun.status, 1, staleContextRun.stdout);
    assert.match(
      staleContextRun.stdout,
      /requiresIsolation must receive the active test context/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CI rejects zero selected tests and todo tests', async () => {
  const directory = await mkdtemp(
    join(process.cwd(), 'test/isolation-selection-attacks-'),
  );
  const wrapper = new URL('../scripts/test-suite.mjs', import.meta.url)
    .pathname;
  const runnerEnv = { ...process.env };
  delete runnerEnv.NODE_TEST_CONTEXT;
  const runFixture = async (filename: string, source: string) => {
    const fixture = join(directory, filename);
    await writeFile(fixture, source);
    return spawnSync(process.execPath, [wrapper, fixture], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...runnerEnv,
        CI: 'true',
        KRN_SCOPE_PROBE: '1',
        KRN_ISOLATION_CAPABILITIES: JSON.stringify(unavailable),
      },
    });
  };

  try {
    const emptyRun = await runFixture('empty.test.mjs', '');
    assert.equal(emptyRun.status, 1, emptyRun.stdout);
    assert.match(emptyRun.stderr, /test suite selected zero tests/u);

    const todoRun = await runFixture(
      'todo.test.mjs',
      `import { test } from 'node:test';\ntest('deferred test', (t) => t.todo('not implemented'));\n`,
    );
    assert.equal(todoRun.status, 1, todoRun.stdout);
    assert.match(todoRun.stderr, /test suite reported 1 todo tests/u);
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
