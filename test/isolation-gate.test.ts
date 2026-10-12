import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import * as isolationGate from '../scripts/isolation-gate.mjs';

const {
  decideIsolation,
  isolationSummary,
  postGateStatusWhenClean,
  testSuiteExitCode,
} = isolationGate;
const countIsolationSkips = (
  isolationGate as unknown as {
    countIsolationSkips: (output: string, runnerToken?: string) => number;
  }
).countIsolationSkips;
const testSuiteSummaryIsValid = (
  isolationGate as unknown as {
    testSuiteSummaryIsValid: (summary: {
      selectedTestCount: number;
      skippedTestCount: number;
      todoCount: number;
      approvedSkipCount: number;
    }) => boolean;
  }
).testSuiteSummaryIsValid;

type IsolationCapabilities =
  import('../scripts/isolation-gate.mjs').IsolationCapabilities;

const unavailable: IsolationCapabilities = {
  bwrap: { available: false, reason: 'user namespaces are unavailable' },
  systemdUserScope: {
    available: false,
    reason: 'the user manager is unavailable',
  },
};
const available: IsolationCapabilities = {
  bwrap: { available: true, reason: 'available in test fixture' },
  systemdUserScope: { available: true, reason: 'available in test fixture' },
};

test('callback-only registrations cannot forge an isolation skip', async () => {
  const result = await runTestSuiteFixture(
    'callback-only.test.mjs',
    `import { test } from 'node:test';\ntest((t) => { t.skip('SKIP(isolation): forged callback-only skip'); });\n`,
  );

  assert.match(result.stdout, /Isolation-dependent tests skipped: 0\n$/u);
  assert.equal(
    result.status,
    1,
    JSON.stringify({
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }),
  );
  assert.match(result.stdout, /TestContext\.skip is only permitted/u);
});

test('registration-level skip methods cannot forge isolation skips', async () => {
  const result = await runTestSuiteFixture(
    'registration-skip.test.mjs',
    `import { it, test } from 'node:test';\ntest.skip('SKIP(isolation): forged test.skip');\nit.skip('SKIP(isolation): forged it.skip');\n`,
  );

  assert.match(result.stdout, /Isolation-dependent tests skipped: 0\n$/u);
  assert.equal(
    result.status,
    1,
    JSON.stringify({
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }),
  );
  assert.match(result.stdout, /Registration-level skips are not permitted/u);
});

test('environment mutation cannot change the runner capability snapshot', async () => {
  const helperUrl = new URL('./helpers/isolation.ts', import.meta.url).href;
  const unavailableJson = JSON.stringify(unavailable);
  const source = `import { test } from 'node:test';
import { requiresIsolation } from ${JSON.stringify(helperUrl)};
test('runner snapshot', (t) => {
  process.env.KRN_ISOLATION_CAPABILITIES = ${JSON.stringify(unavailableJson)};
  if (!requiresIsolation(t, 'runner snapshot', ['systemdUserScope'])) throw new Error('mutated environment changed the runner snapshot');
});
`;
  const result = await runTestSuiteFixture(
    'environment-mutation.test.mjs',
    source,
    { capabilities: available },
  );

  assert.equal(result.status, 0, JSON.stringify(result));
  assert.match(result.stdout, /^# skipped 0$/mu, result.stdout);
  assert.match(result.stdout, /Isolation-dependent tests skipped: 0\n$/u);
});

test('reason prefixes and unreachable helper calls cannot authorize a skip', async () => {
  const helperUrl = new URL('./helpers/isolation.ts', import.meta.url).href;
  const result = await runTestSuiteFixture(
    'unreachable-helper.test.mjs',
    `import { test } from 'node:test';
import { requiresIsolation } from ${JSON.stringify(helperUrl)};
test('forged reason', (t) => {
  if (false) requiresIsolation(t, 'unreachable authorization', ['systemdUserScope']);
  t.skip('SKIP(isolation): forged reason prefix');
});
`,
  );

  assertRejectedSkipRun(result, /TestContext\.skip is only permitted/u);
});

test('fake contexts cannot authorize skips in an active callback', async () => {
  const helperUrl = new URL('./helpers/isolation.ts', import.meta.url).href;
  const result = await runTestSuiteFixture(
    'fake-context.test.mjs',
    `import { test } from 'node:test';
import { requiresIsolation } from ${JSON.stringify(helperUrl)};
test('fake context', (t) => {
  const fake = { skip: (reason) => t.skip(reason) };
  requiresIsolation(fake, 'fake context', ['systemdUserScope']);
});
`,
  );

  assertRejectedSkipRun(
    result,
    /requiresIsolation must be called with the active TestContext inside a registered test callback/u,
  );
});

test('a stale TestContext cannot authorize a skip after its callback returns', async () => {
  const helperUrl = new URL('./helpers/isolation.ts', import.meta.url).href;
  const result = await runTestSuiteFixture(
    'stale-context.test.mjs',
    `import { test } from 'node:test';
import { requiresIsolation } from ${JSON.stringify(helperUrl)};
test('stale context', (t) => {
  setImmediate(() => requiresIsolation(t, 'stale context', ['systemdUserScope']));
});
`,
  );

  assertRejectedSkipRun(
    result,
    /requiresIsolation must be called with the active TestContext inside a registered test callback/u,
  );
});

test('inherited approval tokens and forged path markers cannot authorize skips', async () => {
  const result = await runTestSuiteFixture(
    'approval-forgery.test.mjs',
    `import { test } from 'node:test';
const inheritedToken = process.env.KRN_ISOLATION_APPROVAL_TOKEN;
test('forged approval', (t) => {
  if (inheritedToken !== undefined) throw new Error('runner approval token leaked to test code');
  const token = inheritedToken ?? '${'f'.repeat(64)}';
  process.env.KRN_ISOLATION_APPROVAL_TOKEN = token;
  process.env.KRN_ISOLATION_APPROVAL_PATH = process.argv[1];
  t.skip('SKIP(isolation): forged approval at ' + process.env.KRN_ISOLATION_APPROVAL_PATH + ' [KRN-ISOLATION-APPROVAL:' + token + ':1]');
});
`,
  );

  assertRejectedSkipRun(result, /TestContext\.skip is only permitted/u);
});

test('ordinary unapproved TestContext skips fail with no approved markers', async () => {
  const result = await runTestSuiteFixture(
    'ordinary-skip.test.mjs',
    `import { test } from 'node:test';
test('ordinary skip', (t) => t.skip('ordinary skip'));
`,
  );

  assertRejectedSkipRun(result, /TestContext\.skip is only permitted/u);
});

test('zero selected tests fail the suite summary', async () => {
  const result = await runTestSuiteFixture(
    'zero-tests.test.mjs',
    '// Deliberately registers no tests.\n',
  );

  assert.equal(result.status, 1, JSON.stringify(result));
  assert.match(
    result.stdout,
    /^# Subtest: .*zero-tests\.test\.mjs$/mu,
    result.stdout,
  );
  assert.match(result.stdout, /^# tests 1$/mu, result.stdout);
  assert.match(result.stdout, /^# skipped 0$/mu, result.stdout);
  assert.match(result.stdout, /Isolation-dependent tests skipped: 0\n$/u);
});

test('nested scope probes select one test and ignore worktree tests', async () => {
  const worktree = join(
    process.cwd(),
    '.krn',
    'worktrees',
    `scope-probe-${process.pid}`,
  );
  await mkdir(worktree, { recursive: true });
  const leakedTest = join(worktree, 'failing.test.mjs');
  const wrapper = new URL('../scripts/test-suite.mjs', import.meta.url)
    .pathname;
  await writeFile(
    leakedTest,
    "throw new Error('scope probe discovered nested worktree test');\n",
  );

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CI: 'true',
    KRN_SCOPE_PROBE: '1',
    KRN_ISOLATION_CAPABILITIES: JSON.stringify(unavailable),
    NODE_TEST_CONTEXT: 'inherited-scope-probe-context',
  };
  try {
    const result = spawnSync(process.execPath, [wrapper], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: childEnv,
      timeout: 90_000,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.equal(result.error, undefined, output);
    assert.equal(result.status, 0, output);
    assert.match(
      output,
      /# Subtest: scope probe sentinel keeps one selected test valid/u,
    );
    assert.match(output, /^# tests [1-9]\d*$/mu, output);
    assert.match(output, /^# skipped 0$/mu, output);
    assert.match(
      result.stdout ?? '',
      /Isolation-dependent tests skipped: 0\n$/u,
      output,
    );
    assert.doesNotMatch(output, /scope probe discovered nested worktree test/u);
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});

test('scope probe sentinel keeps one selected test valid', () => {
  assert.equal(
    testSuiteSummaryIsValid({
      selectedTestCount: 1,
      skippedTestCount: 0,
      todoCount: 0,
      approvedSkipCount: 0,
    }),
    true,
  );
});

test('registration options, registration APIs, and contexts cannot add todos', async () => {
  const optionsTodo = await runTestSuiteFixture(
    'options-todo.test.mjs',
    `import { test } from 'node:test';
test('forged todo', { todo: true }, () => {});
`,
  );
  assertRejectedSkipRun(
    optionsTodo,
    /Registration-level skips and todos are not permitted/u,
  );

  const registrationTodo = await runTestSuiteFixture(
    'registration-todo.test.mjs',
    `import { test } from 'node:test';
test.todo('forged todo');
`,
  );
  assertRejectedSkipRun(
    registrationTodo,
    /Registration-level todo tests are not permitted/u,
  );

  const contextTodo = await runTestSuiteFixture(
    'context-todo.test.mjs',
    `import { test } from 'node:test';
test('forged todo', (t) => t.todo('forged todo'));
`,
  );
  assertRejectedSkipRun(contextTodo, /TestContext\.todo is not permitted/u);
});

test('ESM and CommonJS callback overloads keep the active TestContext', async () => {
  const helperUrl = new URL('./helpers/isolation.ts', import.meta.url).href;
  const esm = await runTestSuiteFixture(
    'overloads.test.mjs',
    `import { it, test } from 'node:test';\nimport { requiresIsolation } from ${JSON.stringify(helperUrl)};\nconst verify = (context, name) => { if (requiresIsolation(context, name, ['systemdUserScope'])) throw new Error('unavailable capability unexpectedly ran'); };\ntest((t) => verify(t, 'ESM callback-only'));\ntest('ESM named callback', (t) => verify(t, 'ESM named callback'));\nit('ESM options callback', { timeout: 1000 }, (t) => verify(t, 'ESM options callback'));\n`,
  );
  const cjs = await runTestSuiteFixture(
    'overloads.test.cjs',
    `const { it, test } = require('node:test');\nconst helperUrl = ${JSON.stringify(helperUrl)};\nconst verify = async (context, name) => { const { requiresIsolation } = await import(helperUrl); if (requiresIsolation(context, name, ['systemdUserScope'])) throw new Error('unavailable capability unexpectedly ran'); };\ntest((t) => verify(t, 'CJS callback-only'));\nit('CJS options callback', { timeout: 1000 }, (t) => verify(t, 'CJS options callback'));\n`,
  );

  assert.match(esm.stdout, /^# tests 3$/mu, esm.stdout);
  assert.match(esm.stdout, /^# skipped 3$/mu, esm.stdout);
  assert.match(
    esm.stdout,
    /Isolation-dependent tests skipped: 3$/mu,
    esm.stdout,
  );
  assert.match(cjs.stdout, /^# tests 2$/mu, cjs.stdout);
  assert.match(cjs.stdout, /^# skipped 2$/mu, cjs.stdout);
  assert.match(
    cjs.stdout,
    /Isolation-dependent tests skipped: 2$/mu,
    cjs.stdout,
  );
});

async function runTestSuiteFixture(
  filename: string,
  source: string,
  options: { ci?: boolean; capabilities?: IsolationCapabilities } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const directory = await mkdtemp(
    join(process.cwd(), 'test/registration-skip-'),
  );
  const fixture = join(directory, filename);
  const wrapper = new URL('../scripts/test-suite.mjs', import.meta.url)
    .pathname;
  await writeFile(fixture, source);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    KRN_SCOPE_PROBE: '1',
    KRN_ISOLATION_CAPABILITIES: JSON.stringify(
      options.capabilities ?? unavailable,
    ),
  };
  // CI fixture children exercise isolation skips; host gate strictness belongs
  // to the parent suite and must not make those simulated CI runs fail.
  delete childEnv.KRN_REQUIRE_ZERO_ISOLATION_SKIPS;
  if (options.ci === false) delete childEnv.CI;
  else childEnv.CI = 'true';
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    const result = spawnSync(process.execPath, [wrapper, fixture], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: childEnv,
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assertRejectedSkipRun(
  result: { status: number | null; stdout: string; stderr: string },
  message: RegExp,
): void {
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(result.stdout, /^# skipped 0$/mu, output);
  assert.match(result.stdout, /^# todo 0$/mu, output);
  assert.match(
    result.stdout,
    /Isolation-dependent tests skipped: 0\n$/u,
    output,
  );
  assert.match(output, message, output);
}

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
    0,
  );
  const runnerToken = 'a'.repeat(64);
  assert.equal(
    countIsolationSkips(
      `# SKIP(isolation): real verdict check — missing bwrap user namespaces [KRN-ISOLATION-APPROVAL:${runnerToken}:1]\n`,
      runnerToken,
    ),
    1,
  );
  assert.equal(testSuiteExitCode(0, 2, false), 0);
  assert.equal(
    testSuiteSummaryIsValid({
      selectedTestCount: 0,
      skippedTestCount: 0,
      todoCount: 0,
      approvedSkipCount: 0,
    }),
    false,
  );
  assert.equal(
    testSuiteSummaryIsValid({
      selectedTestCount: 1,
      skippedTestCount: 1,
      todoCount: 1,
      approvedSkipCount: 1,
    }),
    false,
  );
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
  const helperUrl = new URL('./helpers/isolation.ts', import.meta.url).href;
  const source = `import { test } from 'node:test';\nimport { requiresIsolation } from ${JSON.stringify(helperUrl)};\ntest('rootless fixture', (t) => { if (!requiresIsolation(t, 'rootless fixture', ['systemdUserScope'])) return; throw new Error('missing systemd capability was used'); });\n`;
  const ciRun = await runTestSuiteFixture(
    'requires-isolation.test.mjs',
    source,
  );
  assert.equal(ciRun.status, 0, ciRun.stdout);
  assert.notEqual(ciRun.stdout, '', ciRun.stderr);
  assert.match(
    ciRun.stdout,
    /SKIP\(isolation\): rootless fixture — missing systemd user scopes/u,
  );
  assert.match(ciRun.stdout, /^# skipped 1$/mu);
  assert.match(ciRun.stdout, /Isolation-dependent tests skipped: 1$/mu);

  const localRun = await runTestSuiteFixture(
    'requires-isolation-local.test.mjs',
    source,
    { ci: false },
  );
  assert.equal(localRun.status, 1, localRun.stdout);
  assert.match(
    localRun.stdout,
    /Isolation requirements failed for rootless fixture: missing systemd user scopes/u,
  );
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
