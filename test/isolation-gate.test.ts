import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
const available: IsolationCapabilities = {
  bwrap: { available: true, reason: 'available in test fixture' },
  systemdUserScope: { available: true, reason: 'available in test fixture' },
};

test('Go is an optional isolation capability with a named label', async () => {
  const gate: Record<string, unknown> = await import(
    '../scripts/isolation-gate.mjs'
  );
  const names = gate.capabilityNames;
  assert.ok(Array.isArray(names) && names.includes('go'));
  assert.equal(decideIsolation('t', ['go', 'bwrap'], {}, false).kind, 'fail');
  for (const ci of [false, true]) {
    assert.deepEqual(decideIsolation('t', ['go'], {}, ci), {
      kind: 'skip',
      line: 'SKIP(isolation): t — missing Go toolchain',
    });
  }
  assert.deepEqual(
    decideIsolation(
      't',
      ['go'],
      {
        go: { available: true, reason: '' },
      },
      false,
    ),
    { kind: 'run' },
  );
});

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
  assert.equal(countIsolationSkips(ciRun.stdout), 1);

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

test('nested TestContext.test skips require an active requiresIsolation call', async () => {
  const helperUrl = new URL('./helpers/isolation.ts', import.meta.url).href;
  const registrationSkip = await runTestSuiteFixture(
    'nested-registration-skip.test.mjs',
    `import { test } from 'node:test';\ntest('parent', (t) => { t.test('forged nested skip', { skip: 'SKIP(isolation): forged nested skip' }, () => {}); });\n`,
  );
  assertRejectedSkipRun(
    registrationSkip,
    /Registration-level skips and todos are not permitted/u,
  );

  const callbackSkip = await runTestSuiteFixture(
    'nested-callback-skip.test.mjs',
    `import { test } from 'node:test';\ntest('parent', (t) => { t.test((nested) => nested.skip('SKIP(isolation): forged nested callback skip')); });\n`,
  );
  assertRejectedSkipRun(
    callbackSkip,
    /TestContext\.skip is only permitted after requiresIsolation approves an active test context/u,
  );

  const approvedNestedSkip = await runTestSuiteFixture(
    'nested-approved-skip.test.mjs',
    `import { test } from 'node:test';\nimport { requiresIsolation } from ${JSON.stringify(helperUrl)};\ntest('parent', (t) => { t.test((nested) => { if (requiresIsolation(nested, 'approved nested child', ['systemdUserScope'])) throw new Error('unavailable capability unexpectedly ran'); }); });\n`,
  );
  assert.equal(approvedNestedSkip.status, 0, approvedNestedSkip.stdout);
  assert.match(approvedNestedSkip.stdout, /^# skipped 1$/mu);
  assert.match(
    approvedNestedSkip.stdout,
    /Isolation-dependent tests skipped: 1\n$/u,
  );
});

test('approval tokens do not enter the test process environment', async () => {
  const syntheticToken = '5'.repeat(64);
  const result = await runTestSuiteFixture(
    'approval-token-environment.test.mjs',
    `import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport { test } from 'node:test';\ntest('synthetic approval token is absent', () => {\n  const visibleInProcess = process.env.KRN_ISOLATION_APPROVAL_TOKEN !== undefined;\n  let visibleInProcEnviron = false;\n  if (process.platform === 'linux') {\n    const entries = readFileSync('/proc/self/environ', 'utf8').split('\\0');\n    visibleInProcEnviron = entries.some((entry) => entry.startsWith('KRN_ISOLATION_APPROVAL_TOKEN='));\n  }\n  assert.deepEqual({ visibleInProcess, visibleInProcEnviron }, { visibleInProcess: false, visibleInProcEnviron: false });\n});\n`,
    {
      environment: { KRN_ISOLATION_APPROVAL_TOKEN: syntheticToken },
    },
  );
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /^# tests 1$/mu, result.stdout);
  assert.match(result.stdout, /^# pass 1$/mu, result.stdout);
});

test('callback-only registrations cannot authorize TestContext.skip', async () => {
  const result = await runTestSuiteFixture(
    'callback-only-skip.test.mjs',
    `import { test } from 'node:test';\ntest((context) => context.skip('SKIP(isolation): forged callback-only skip'));\n`,
  );
  assertRejectedSkipRun(result, /TestContext\.skip is only permitted/u);
});

test('top-level registration skip forms are rejected', async () => {
  for (const [filename, source] of [
    [
      'test-skip-api.test.mjs',
      `import { test } from 'node:test';\ntest.skip('SKIP(isolation): forged test.skip');\n`,
    ],
    [
      'it-skip-api.test.mjs',
      `import { it } from 'node:test';\nit.skip('SKIP(isolation): forged it.skip');\n`,
    ],
    [
      'registration-option-skip.test.mjs',
      `import { test } from 'node:test';\ntest('forged option skip', { skip: true }, () => {});\n`,
    ],
    [
      'registration-option-getter-skip.test.mjs',
      `import { test } from 'node:test';\nlet reads = 0;\nconst options = Object.defineProperty({}, 'skip', { enumerable: true, get: () => ++reads > 1 });\ntest('changing option skip', options, () => {});\n`,
    ],
  ] as const) {
    const result = await runTestSuiteFixture(filename, source);
    assertRejectedSkipRun(result, /Registration-level skips.*not permitted/u);
  }
});

test('environment mutation cannot change the runner capability snapshot', async () => {
  const helperUrl = new URL('./helpers/isolation.ts', import.meta.url).href;
  const result = await runTestSuiteFixture(
    'environment-mutation.test.mjs',
    `import { test } from 'node:test';\nimport { requiresIsolation } from ${JSON.stringify(helperUrl)};\ntest('runner snapshot', (context) => {\n  process.env.CI = 'false';\n  process.env.KRN_ISOLATION_CAPABILITIES = ${JSON.stringify(JSON.stringify(unavailable))};\n  if (!requiresIsolation(context, 'runner snapshot', ['systemdUserScope'])) throw new Error('mutated environment changed the runner snapshot');\n});\n`,
    { capabilities: available },
  );
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /^# skipped 0$/mu, result.stdout);
  assert.match(result.stdout, /Isolation-dependent tests skipped: 0\n$/u);
});

test('reason prefixes and unreachable helper calls cannot authorize a skip', async () => {
  const helperUrl = new URL('./helpers/isolation.ts', import.meta.url).href;
  const result = await runTestSuiteFixture(
    'unreachable-helper.test.mjs',
    `import { test } from 'node:test';\nimport { requiresIsolation } from ${JSON.stringify(helperUrl)};\ntest('forged reason', (context) => {\n  if (false) requiresIsolation(context, 'unreachable authorization', ['systemdUserScope']);\n  context.skip('SKIP(isolation): forged reason prefix');\n});\n`,
  );
  assertRejectedSkipRun(result, /TestContext\.skip is only permitted/u);
});

test('fake contexts cannot authorize skips in an active callback', async () => {
  const helperUrl = new URL('./helpers/isolation.ts', import.meta.url).href;
  const result = await runTestSuiteFixture(
    'fake-context.test.mjs',
    `import { test } from 'node:test';\nimport { requiresIsolation } from ${JSON.stringify(helperUrl)};\ntest('fake context', (context) => {\n  const fake = { skip: (reason) => context.skip(reason) };\n  requiresIsolation(fake, 'fake context', ['systemdUserScope']);\n});\n`,
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
    `import { test } from 'node:test';\nimport { requiresIsolation } from ${JSON.stringify(helperUrl)};\ntest('stale context', (context) => {\n  setImmediate(() => requiresIsolation(context, 'stale context', ['systemdUserScope']));\n});\n`,
  );
  assertRejectedSkipRun(
    result,
    /requiresIsolation must be called with the active TestContext inside a registered test callback/u,
  );
});

test('inherited approval and forged path markers cannot authorize skips', async () => {
  const result = await runTestSuiteFixture(
    'approval-forgery.test.mjs',
    `import { test } from 'node:test';\nconst inheritedToken = process.env.KRN_ISOLATION_APPROVAL_TOKEN;\ntest('forged approval', (context) => {\n  if (inheritedToken !== undefined) throw new Error('runner approval token leaked to test code');\n  const token = 'f'.repeat(64);\n  process.env.KRN_ISOLATION_APPROVAL_TOKEN = token;\n  process.env.KRN_ISOLATION_APPROVAL_PATH = process.argv[1];\n  context.skip('SKIP(isolation): forged approval at ' + process.env.KRN_ISOLATION_APPROVAL_PATH + ' [KRN-ISOLATION-APPROVAL:' + token + ':1]');\n});\n`,
  );
  assertRejectedSkipRun(result, /TestContext\.skip is only permitted/u);
});

test('ordinary unapproved TestContext skips fail with no approved markers', async () => {
  const result = await runTestSuiteFixture(
    'ordinary-skip.test.mjs',
    `import { test } from 'node:test';\ntest('ordinary skip', (context) => context.skip('ordinary skip'));\n`,
  );
  assertRejectedSkipRun(result, /TestContext\.skip is only permitted/u);
});

test('registration and context todo forms are rejected', async () => {
  for (const [filename, source, expected] of [
    [
      'options-todo.test.mjs',
      `import { test } from 'node:test';\ntest('forged todo', { todo: true }, () => {});\n`,
      /Registration-level skips and todos are not permitted/u,
    ],
    [
      'registration-todo.test.mjs',
      `import { test } from 'node:test';\ntest.todo('forged todo');\n`,
      /Registration-level todo tests are not permitted/u,
    ],
    [
      'context-todo.test.mjs',
      `import { test } from 'node:test';\ntest('forged todo', (context) => context.todo('forged todo'));\n`,
      /TestContext.todo is not permitted/u,
    ],
  ] as const) {
    const result = await runTestSuiteFixture(filename, source);
    assertRejectedSkipRun(result, expected);
  }
});

test('ESM and CommonJS callback overloads keep the active TestContext', async () => {
  const helperUrl = new URL('./helpers/isolation.ts', import.meta.url).href;
  const esm = await runTestSuiteFixture(
    'callback-overloads.test.mjs',
    `import { it, test } from 'node:test';\nimport { requiresIsolation } from ${JSON.stringify(helperUrl)};\nconst verify = (context, name) => { if (requiresIsolation(context, name, ['systemdUserScope'])) throw new Error('unavailable capability unexpectedly ran'); };\ntest((context) => verify(context, 'ESM callback-only'));\ntest('ESM named callback', (context) => verify(context, 'ESM named callback'));\nit('ESM options callback', { timeout: 1000 }, (context) => verify(context, 'ESM options callback'));\n`,
  );
  const cjs = await runTestSuiteFixture(
    'callback-overloads.test.cjs',
    `const { it, test } = require('node:test');\nconst helperUrl = ${JSON.stringify(helperUrl)};\nconst verify = async (context, name) => { const { requiresIsolation } = await import(helperUrl); if (requiresIsolation(context, name, ['systemdUserScope'])) throw new Error('unavailable capability unexpectedly ran'); };\ntest((context) => verify(context, 'CJS callback-only'));\nit('CJS options callback', { timeout: 1000 }, (context) => verify(context, 'CJS options callback'));\n`,
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

for (const [signal, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const) {
  test(`${signal} of the test-suite wrapper stops its sleeping test child`, async (t) => {
    await assertTestSuiteSignal(signal, exitCode, false);
    await assertTestSuiteSignal(signal, exitCode, true);
    await t.test(
      `${signal} during reporter setup is handled and cleaned`,
      async () => {
        await assertTestSuiteStartupSignal(signal, exitCode);
      },
    );
  });
}

async function assertTestSuiteSignal(
  signal: NodeJS.Signals,
  expectedExitCode: number,
  strictMode: boolean,
): Promise<void> {
  const directory = await mkdtemp(join(process.cwd(), 'test/wrapper-signal-'));
  const fixture = join(directory, 'sleeping.test.mjs');
  const pidFile = join(directory, 'child.pid');
  const wrapper = new URL('../scripts/test-suite.mjs', import.meta.url)
    .pathname;
  const eventStateRoot = join(process.cwd(), '.krn/tmp');
  await mkdir(eventStateRoot, { recursive: true });
  const existingEventDirectories = new Set(
    (await readdir(eventStateRoot)).filter((entry) =>
      entry.startsWith('strict-test-events-'),
    ),
  );
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
    delete wrapperEnv.KRN_SCOPE_PROBE;
    if (strictMode) wrapperEnv.KRN_REQUIRE_ZERO_ISOLATION_SKIPS = '1';
    else delete wrapperEnv.KRN_REQUIRE_ZERO_ISOLATION_SKIPS;
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
    if (strictMode) {
      assert.match(
        output,
        /^KRN_TEST_SUMMARY_JSON=.*"success":false/mu,
        `${output}\n${errors}`,
      );
      const remainingEventDirectories = (await readdir(eventStateRoot)).filter(
        (entry) =>
          entry.startsWith('strict-test-events-') &&
          !existingEventDirectories.has(entry),
      );
      assert.deepEqual(remainingEventDirectories, [], `${output}\n${errors}`);
    }
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

type StartupSignal = 'SIGINT' | 'SIGTERM';
type StartupSignalExitCode = 130 | 143;

async function assertTestSuiteStartupSignal(
  signal: StartupSignal,
  expectedExitCode: StartupSignalExitCode,
): Promise<void> {
  const repositoryStateRoot = join(process.cwd(), '.krn/tmp');
  await mkdir(repositoryStateRoot, { recursive: true });
  const fixture = await mkdtemp(
    join(repositoryStateRoot, 'startup-signal-fixture-'),
  );
  const stateRoot = join(fixture, '.krn/tmp');
  const testFile = join(fixture, 'startup.test.mjs');
  const marker = join(fixture, 'test-ran');
  const observer = join(fixture, 'signal-after-event-write.mjs');
  const observerReceipt = join(fixture, 'observer-receipt');

  try {
    await mkdir(stateRoot, { recursive: true });
    const nodeVersion = await readFile(
      join(process.cwd(), '.node-version'),
      'utf8',
    );
    await writeFile(join(fixture, '.node-version'), nodeVersion);
    await writeFile(
      testFile,
      `import { writeFileSync } from 'node:fs';\nimport { test } from 'node:test';\ntest('must not execute after startup signal', () => writeFileSync(${JSON.stringify(marker)}, 'ran'));\n`,
    );
    await writeFile(
      observer,
      [
        "import fs from 'node:fs/promises';",
        "import { writeFileSync } from 'node:fs';",
        "import { syncBuiltinESMExports } from 'node:module';",
        'const originalWriteFile = fs.writeFile;',
        'let signalSent = false;',
        'fs.writeFile = async (...args) => {',
        '  const [file] = args;',
        '  const result = await originalWriteFile(...args);',
        '  const target = String(file);',
        "  if (!signalSent && target.includes('strict-test-events-') && target.endsWith('events.jsonl')) {",
        '    signalSent = true;',
        `    writeFileSync(${JSON.stringify(observerReceipt)}, 'event file written');`,
        '    const signal = process.env.KRN_SETUP_SIGNAL;',
        "    if (signal !== 'SIGINT' && signal !== 'SIGTERM') throw new Error('unexpected setup signal');",
        '    process.kill(process.pid, signal);',
        '    await new Promise((resolve) => setTimeout(resolve, 100));',
        '  }',
        '  return result;',
        '};',
        'syncBuiltinESMExports();',
        '',
      ].join('\n'),
    );

    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CI;
    delete env.NODE_OPTIONS;
    delete env.KRN_SCOPE_PROBE;
    delete env.NODE_TEST_CONTEXT;
    delete env.GITHUB_STEP_SUMMARY;
    for (const key of Object.keys(env)) {
      if (key.startsWith('NODE_TEST_')) delete env[key];
    }
    env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS = '1';
    env.KRN_SETUP_SIGNAL = signal;

    const wrapper = new URL('../scripts/test-suite.mjs', import.meta.url)
      .pathname;
    const result = spawnSync(
      process.execPath,
      ['--import', observer, wrapper, testFile],
      {
        cwd: fixture,
        encoding: 'utf8',
        env,
        timeout: 30_000,
      },
    );
    const details = `status=${result.status}, signal=${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    assert.equal(result.error, undefined, details);
    assert.equal(
      await fileExists(observerReceipt),
      true,
      `observer did not signal after writing the event file\n${details}`,
    );
    const startupSummaries =
      result.stdout.match(/^KRN_TEST_SUMMARY_JSON=.*$/gmu) ?? [];
    const startupSummaryLine = startupSummaries[0];
    const startupFinalLine = result.stdout.trimEnd().split(/\r?\n/u).at(-1);
    const startupSummaryIsFinal =
      startupSummaries.length === 1 &&
      startupSummaryLine !== undefined &&
      startupFinalLine === startupSummaryLine;
    const startupSummaryFailed =
      startupSummaryLine !== undefined &&
      startupSummaryIsFinal &&
      startupSummaryLine.includes('"success":false');
    const startupRunnerStarted = /^TAP version 13$/mu.test(result.stdout);
    const startupTestRan = await fileExists(marker);
    const startupEventDirectories = (await readdir(stateRoot)).filter((entry) =>
      entry.startsWith('strict-test-events-'),
    );
    assert.deepEqual(
      {
        exitCode: result.status,
        signal: result.signal,
        summaryCount: startupSummaries.length,
        summaryIsFinal: startupSummaryIsFinal,
        summaryFailed: startupSummaryFailed,
        runnerStarted: startupRunnerStarted,
        testRan: startupTestRan,
        remainingEventDirectories: startupEventDirectories,
      },
      {
        exitCode: expectedExitCode,
        signal: null,
        summaryCount: 1,
        summaryIsFinal: true,
        summaryFailed: true,
        runnerStarted: false,
        testRan: false,
        remainingEventDirectories: [],
      },
      details,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runTestSuiteFixture(
  filename: string,
  source: string,
  options: {
    ci?: boolean;
    capabilities?: IsolationCapabilities;
    environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const directory = await mkdtemp(
    join(process.cwd(), 'test/isolation-approval-'),
  );
  const fixture = join(directory, filename);
  const wrapper = new URL('../scripts/test-suite.mjs', import.meta.url)
    .pathname;
  await writeFile(fixture, source);
  const environment: NodeJS.ProcessEnv = {
    ...options.environment,
    KRN_SCOPE_PROBE: '1',
    KRN_ISOLATION_CAPABILITIES: JSON.stringify(
      options.capabilities ?? unavailable,
    ),
  };
  if (options.ci === false) delete environment.CI;
  else environment.CI = 'true';
  try {
    const result = spawnSync(process.execPath, [wrapper, fixture], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: environment,
      timeout: 30_000,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
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
  assert.match(result.stdout, message, output);
}

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

test('Go resolution rejects malformed roots and inactive shims', async (t) => {
  const directory = await mkdtemp(
    join(process.cwd(), '.krn/tmp/go-resolution-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'toolchain');
  await mkdir(join(root, 'bin'), { recursive: true });
  const fake = join(directory, 'go');
  await writeFile(
    fake,
    `#!${process.execPath}
if (process.env.FAKE_INACTIVE) process.exit(1);
process.stdout.write(process.env.FAKE_GOROOT ?? '');
`,
  );
  await chmod(fake, 0o755);
  const moduleUrl = new URL('../scripts/isolation-gate.mjs', import.meta.url)
    .href;
  const resolve = (output: string, inactive = false) => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { resolveGoToolchain } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(resolveGoToolchain() ?? null));`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: directory,
          FAKE_GOROOT: output,
          FAKE_INACTIVE: inactive ? '1' : '',
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  for (const output of [
    '',
    'relative',
    `${root}\nextra\n`,
    join(directory, 'absent'),
    'x'.repeat(5000),
    root,
  ]) {
    assert.equal(resolve(output), null, output);
  }
  await writeFile(join(root, 'bin/go'), 'fixture');
  assert.equal(resolve(root), null, 'non-executable go');
  await chmod(join(root, 'bin/go'), 0o755);
  assert.deepEqual(resolve(`${root}\n`), {
    root,
    binary: join(root, 'bin/go'),
  });
  const alias = join(directory, 'alias');
  await symlink(root, alias);
  assert.deepEqual(resolve(alias), { root, binary: join(root, 'bin/go') });
  assert.equal(resolve(root, true), null, 'inactive mise shim');
  const outside = join(directory, 'outside-go');
  await writeFile(outside, 'fixture');
  await chmod(outside, 0o755);
  await rm(join(root, 'bin/go'));
  await symlink(outside, join(root, 'bin/go'));
  assert.equal(resolve(root), null, 'go binary outside the mounted GOROOT');
});
