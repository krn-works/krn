import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import {
  countIsolationSkips,
  decideIsolation,
  type IsolationCapabilities,
  isolationSummary,
  postGateStatusWhenClean,
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
  assert.equal(
    isolationSummary(['first isolation test', 'second isolation test']),
    'Isolation-dependent tests skipped: 2\nIsolation skip names:\n- first isolation test\n- second isolation test',
  );
  assert.equal(
    countIsolationSkips(
      'ok 1 - real verdict check # SKIP SKIP(isolation): real verdict check — missing bwrap user namespaces\n',
    ),
    1,
  );
  assert.equal(
    countIsolationSkips(
      '# SKIP(isolation): printed text alone does not approve a skipped test\n',
    ),
    0,
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
});

test('TAP exit policy rejects zero tests and unapproved CI skips or todos', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test/suite-policy-'));
  const helperUrl = new URL('./helpers/isolation.ts', import.meta.url).href;
  const fixtures = [
    {
      filename: 'skip.test.mjs',
      source:
        "import { test } from 'node:test'; test('ordinary skip', (t) => t.skip('not isolation'));\n",
    },
    {
      filename: 'todo.test.mjs',
      source: "import { test } from 'node:test'; test.todo('ordinary todo');\n",
    },
    {
      filename: 'passing.test.mjs',
      source: "import { test } from 'node:test'; test('pass', () => {});\n",
    },
    {
      filename: 'isolation.test.mjs',
      source: `import { test } from 'node:test';\nimport { requiresIsolation } from ${JSON.stringify(helperUrl)};\ntest('approved isolation skip', (t) => { if (!requiresIsolation(t, 'approved isolation skip', ['systemdUserScope'])) return; throw new Error('missing systemd capability was used'); });\n`,
    },
    {
      filename: 'forged-isolation.test.mjs',
      source:
        "import { test } from 'node:test'; test('forged isolation skip', (t) => t.skip('SKIP(isolation): forged isolation skip — missing systemd user scopes'));\n",
    },
    {
      filename: 'stale-isolation-signal.test.mjs',
      source: `import { appendFileSync } from 'node:fs';\nimport { test } from 'node:test';\nconst reason = 'SKIP(isolation): stale isolation signal — missing systemd user scopes';\nif (process.env.KRN_ISOLATION_SKIP_FILE) appendFileSync(process.env.KRN_ISOLATION_SKIP_FILE, JSON.stringify({ nonce: '${'0'.repeat(64)}', testName: 'stale isolation signal', line: reason }) + '\\n');\ntest('stale isolation signal', (t) => t.skip(reason));\n`,
    },
  ];

  try {
    const fixturePaths = new Map<string, string>();
    for (const fixture of fixtures) {
      const path = join(directory, fixture.filename);
      await writeFile(path, fixture.source);
      fixturePaths.set(fixture.filename, path);
    }

    const contextSkipPath = fixturePaths.get('skip.test.mjs');
    const todoPath = fixturePaths.get('todo.test.mjs');
    const passingPath = fixturePaths.get('passing.test.mjs');
    const isolationPath = fixturePaths.get('isolation.test.mjs');
    const forgedIsolationPath = fixturePaths.get('forged-isolation.test.mjs');
    const staleSignalPath = fixturePaths.get('stale-isolation-signal.test.mjs');
    assert.ok(contextSkipPath);
    assert.ok(todoPath);
    assert.ok(passingPath);
    assert.ok(isolationPath);
    assert.ok(forgedIsolationPath);
    assert.ok(staleSignalPath);

    const zeroTests = runTestSuite([], directory, ciTestEnv());
    const ciSkip = runTestSuite([contextSkipPath], directory, ciTestEnv());
    const ciTodo = runTestSuite([todoPath], directory, ciTestEnv());
    const localSkip = runTestSuite(
      [contextSkipPath],
      directory,
      localTestEnv(),
    );
    const localPass = runTestSuite([passingPath], directory, localTestEnv());
    const approvedIsolationSkip = runTestSuite(
      [isolationPath],
      directory,
      ciTestEnv(),
    );
    const forgedIsolationSkip = runTestSuite(
      [forgedIsolationPath],
      directory,
      ciTestEnv(),
    );
    const staleIsolationSignal = runTestSuite(
      [staleSignalPath],
      directory,
      ciTestEnv(),
    );
    const requiredZeroIsolationSkip = runTestSuite([isolationPath], directory, {
      ...ciTestEnv(),
      KRN_REQUIRE_ZERO_ISOLATION_SKIPS: '1',
    });
    const unexpected = [
      ['zero tests must fail', zeroTests.status === 1],
      ['CI context skip must fail', ciSkip.status === 1],
      ['CI todo must fail', ciTodo.status === 1],
      [
        'non-CI skip is accepted without zero-skip policy',
        localSkip.status === 0,
      ],
      ['non-CI passing suite is accepted', localPass.status === 0],
      [
        'approved CI isolation skip is accepted',
        approvedIsolationSkip.status === 0,
      ],
      [
        'CI skip with a forged isolation reason must fail',
        forgedIsolationSkip.status === 1,
      ],
      [
        'CI skip with a stale isolation signal must fail',
        staleIsolationSignal.status === 1,
      ],
      [
        'zero-isolation requirement rejects approved skips',
        requiredZeroIsolationSkip.status === 1 &&
          /gate:local requires zero isolation skips/u.test(
            requiredZeroIsolationSkip.stderr,
          ),
      ],
    ].filter(([, accepted]) => !accepted);

    assert.deepEqual(
      unexpected,
      [],
      JSON.stringify({
        zeroTests: { status: zeroTests.status, stdout: zeroTests.stdout },
        ciSkip: { status: ciSkip.status, stdout: ciSkip.stdout },
        ciTodo: { status: ciTodo.status, stdout: ciTodo.stdout },
        localSkip: { status: localSkip.status, stdout: localSkip.stdout },
        localPass: { status: localPass.status, stdout: localPass.stdout },
        approvedIsolationSkip: {
          status: approvedIsolationSkip.status,
          stdout: approvedIsolationSkip.stdout,
        },
        forgedIsolationSkip: {
          status: forgedIsolationSkip.status,
          stdout: forgedIsolationSkip.stdout,
          stderr: forgedIsolationSkip.stderr,
        },
        staleIsolationSignal: {
          status: staleIsolationSignal.status,
          stdout: staleIsolationSignal.stdout,
          stderr: staleIsolationSignal.stderr,
        },
        requiredZeroIsolationSkip: {
          status: requiredZeroIsolationSkip.status,
          stderr: requiredZeroIsolationSkip.stderr,
        },
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('scope-probe test-suite scans the normal test tree but runs a sentinel only', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test/scope-probe-'));
  const testDirectory = join(directory, 'test');
  const nestedWorktree = join(directory, '.krn/worktrees/scope-probe');
  await mkdir(testDirectory, { recursive: true });
  await mkdir(nestedWorktree, { recursive: true });
  await writeFile(
    join(testDirectory, 'sentinel.test.ts'),
    "import { test } from 'node:test'; test('missing isolation outside CI is a failure decision', () => {});\n",
  );
  await writeFile(
    join(testDirectory, 'unselected.test.ts'),
    "import { test } from 'node:test'; test('scope-probe must not run unrelated cases', () => { throw new Error('scope-probe ran unrelated test bodies'); });\n",
  );
  await writeFile(
    join(nestedWorktree, 'failing.test.ts'),
    "import assert from 'node:assert/strict'; assert.fail('test runner discovered nested worktree state');\n",
  );

  try {
    const result = runTestSuite([], directory, ciTestEnv());
    assert.equal(
      result.status,
      0,
      `scope-probe suite failed:\n${result.stdout}\n${result.stderr}`,
    );
    assert.match(result.stdout, /^# tests 2$/mu);
    assert.match(
      result.stdout,
      /^ok 1 - missing isolation outside CI is a failure decision$/mu,
    );
    assert.doesNotMatch(
      result.stdout,
      /scope-probe must not run unrelated cases/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('requiresIsolation logs a named CI skip and fails when CI is absent', async () => {
  const tempRoot = join(process.cwd(), 'test');
  const directory = await mkdtemp(join(tempRoot, 'isolation-helper-'));
  const fixture = join(directory, 'requires-isolation.test.mjs');
  const signalFile = join(directory, 'isolation-skip-signals.jsonl');
  const helperUrl = new URL('./helpers/isolation.ts', import.meta.url).href;
  await writeFile(signalFile, '');
  await writeFile(
    fixture,
    `import { test } from 'node:test';\nimport { requiresIsolation } from ${JSON.stringify(helperUrl)};\ntest('rootless fixture', (t) => { if (!requiresIsolation(t, 'rootless fixture', ['systemdUserScope'])) return; throw new Error('missing systemd capability was used'); });\n`,
  );

  const baseEnv = { ...process.env };
  delete baseEnv.CI;
  delete baseEnv.NODE_TEST_CONTEXT;
  const capabilities = JSON.stringify(unavailable);
  const helperNonce = 'a'.repeat(64);
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
          KRN_ISOLATION_SKIP_NONCE: helperNonce,
          KRN_ISOLATION_SKIP_FILE: signalFile,
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
    const skipSignals = (await readFile(signalFile, 'utf8'))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line));
    assert.deepEqual(skipSignals, [
      {
        nonce: helperNonce,
        testName: 'rootless fixture',
        line: 'SKIP(isolation): rootless fixture — missing systemd user scopes',
      },
    ]);

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

test('test-suite rejects an empty test glob', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test/empty-suite-'));
  const result = runTestSuite([], directory, ciTestEnv());
  try {
    assert.equal(
      result.status,
      1,
      `zero-test suite unexpectedly passed:\n${result.stdout}\n${result.stderr}`,
    );
    assert.match(result.stdout, /^# tests 0$/mu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('test-suite rejects non-isolation skips and todos in CI', async () => {
  const fixtures = [
    {
      filename: 'context-skip.test.mjs',
      source:
        "import { test } from 'node:test'; test('ordinary context skip', (t) => t.skip('not isolation'));\n",
      summary: /^# skipped 1$/mu,
    },
    {
      filename: 'option-skip.test.mjs',
      source:
        "import { test } from 'node:test'; test('ordinary option skip', { skip: true }, () => {});\n",
      summary: /^# skipped 1$/mu,
    },
    {
      filename: 'todo.test.mjs',
      source: "import { test } from 'node:test'; test.todo('ordinary todo');\n",
      summary: /^# todo 1$/mu,
    },
  ];

  const results: {
    filename: string;
    result: SpawnSyncReturns<string>;
    localResult: SpawnSyncReturns<string>;
    summary: RegExp;
  }[] = [];
  for (const fixture of fixtures) {
    const directory = await mkdtemp(join(process.cwd(), 'test/non-isolation-'));
    const path = join(directory, fixture.filename);
    await writeFile(path, fixture.source);
    try {
      results.push({
        filename: fixture.filename,
        result: runTestSuite([path], directory, ciTestEnv()),
        localResult: runTestSuite([path], directory, localTestEnv()),
        summary: fixture.summary,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const unexpectedlyAccepted = results.filter(
    ({ result }) => result.status !== 1,
  );
  assert.deepEqual(
    unexpectedlyAccepted.map(({ filename, result }) => ({
      filename,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    })),
    [],
    'CI accepted one or more non-isolation skips or todos',
  );
  for (const { filename, result, summary } of results)
    assert.match(
      result.stdout,
      summary,
      `${filename} did not produce its TAP summary:\n${result.stdout}`,
    );
  assert.deepEqual(
    results
      .filter(({ localResult }) => localResult.status !== 0)
      .map(({ filename, localResult }) => ({
        filename,
        status: localResult.status,
        stdout: localResult.stdout,
        stderr: localResult.stderr,
      })),
    [],
    'non-CI test-suite unexpectedly rejected a skip or todo without the zero-skip requirement',
  );
});

test('CI explicitly enables the CI skip policy for the gate step', async () => {
  const workflow = await readFile(
    join(process.cwd(), '.github/workflows/ci.yml'),
    'utf8',
  );
  assert.match(
    workflow,
    /- name: Run gate\n {8}env:\n {10}CI: 'true'\n {8}run: npm run gate/u,
  );
});

test('test-suite reports approved isolation skip names in CI logs and summary', async () => {
  const directory = await mkdtemp(
    join(process.cwd(), 'test/isolation-summary-'),
  );
  const fixture = join(directory, 'isolation.test.mjs');
  const stepSummary = join(directory, 'summary.md');
  const helperUrl = new URL('./helpers/isolation.ts', import.meta.url).href;
  await writeFile(
    fixture,
    `import { test } from 'node:test';\nimport { requiresIsolation } from ${JSON.stringify(helperUrl)};\ntest('reported isolation fixture', (t) => { if (!requiresIsolation(t, 'reported isolation fixture', ['systemdUserScope'])) return; throw new Error('missing systemd capability was used'); });\n`,
  );
  const env = {
    ...ciTestEnv(),
    GITHUB_STEP_SUMMARY: stepSummary,
  };

  try {
    const result = runTestSuite([fixture], directory, env);
    const failures: string[] = [];
    if (result.status !== 0)
      failures.push(`CI-approved isolation skip exited ${result.status}`);
    if (!/^# skipped 1$/mu.test(result.stdout))
      failures.push('TAP did not report one skipped test');
    if (
      !/Isolation-dependent tests skipped: 1[\s\S]*reported isolation fixture/u.test(
        result.stdout,
      )
    )
      failures.push('CI log did not contain the isolation count and test name');

    const summaryExists = await pathExists(stepSummary);
    const summary = summaryExists ? await readFile(stepSummary, 'utf8') : '';
    if (!summaryExists)
      failures.push('CI test runner did not write GITHUB_STEP_SUMMARY');
    if (
      !/Isolation-dependent tests skipped: 1/u.test(summary) ||
      !/reported isolation fixture/u.test(summary)
    )
      failures.push(
        'GitHub step summary did not contain the isolation count and test name',
      );

    const requiredZeroSkipRun = runTestSuite([fixture], directory, {
      ...env,
      KRN_REQUIRE_ZERO_ISOLATION_SKIPS: '1',
    });
    if (
      requiredZeroSkipRun.status !== 1 ||
      !/gate:local requires zero isolation skips/u.test(
        requiredZeroSkipRun.stderr,
      )
    )
      failures.push('KRN_REQUIRE_ZERO_ISOLATION_SKIPS did not refuse the skip');

    assert.deepEqual(
      failures,
      [],
      JSON.stringify({
        stdout: result.stdout,
        stderr: result.stderr,
        stepSummary: summary,
        requiredZeroSkip: {
          status: requiredZeroSkipRun.status,
          stderr: requiredZeroSkipRun.stderr,
        },
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('gate-local refuses tracked and untracked dirt before running the gate', async () => {
  const results: {
    dirtyPath: string;
    result: SpawnSyncReturns<string>;
    ranGate: boolean;
  }[] = [];
  for (const dirtyPath of ['tracked.txt', 'untracked.txt']) {
    const fixture = await createGitFixture();
    try {
      await writeFile(join(fixture.directory, dirtyPath), 'dirty\n');
      const result = runGateLocal(fixture);
      results.push({
        dirtyPath,
        result,
        ranGate: await pathExists(fixture.npmMarker),
      });
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }

  const acceptedDirtyTrees = results.filter(
    ({ result, ranGate }) =>
      result.status !== 1 ||
      ranGate ||
      !/dirty worktree/iu.test(`${result.stdout}\n${result.stderr}`) ||
      /Published krn\/gate-local/u.test(result.stdout),
  );
  assert.deepEqual(
    acceptedDirtyTrees.map(({ dirtyPath, result, ranGate }) => ({
      dirtyPath,
      status: result.status,
      ranGate,
      stdout: result.stdout,
      stderr: result.stderr,
    })),
    [],
    'gate-local ran or published from one or more dirty worktrees',
  );
});

test('gate-local ignores ignored files when checking cleanliness', async () => {
  const fixture = await createGitFixture({ ignoredPath: 'ignored.txt' });
  try {
    await writeFile(join(fixture.directory, 'ignored.txt'), 'ignored\n');
    const result = runGateLocal(fixture);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.equal(
      await pathExists(fixture.npmMarker),
      true,
      `ignored files blocked a clean gate:\n${result.stdout}\n${result.stderr}`,
    );
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      /dirty worktree/u,
    );
    assert.doesNotMatch(result.stdout, /Published krn\/gate-local/u);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

function ciTestEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS;
  return {
    ...env,
    CI: 'true',
    KRN_SCOPE_PROBE: '1',
    KRN_ISOLATION_CAPABILITIES: JSON.stringify(unavailable),
  };
}

function localTestEnv(): NodeJS.ProcessEnv {
  const env = ciTestEnv();
  delete env.CI;
  return env;
}

function runTestSuite(
  paths: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  const wrapper = new URL('../scripts/test-suite.mjs', import.meta.url)
    .pathname;
  return spawnSync(process.execPath, [wrapper, ...paths], {
    cwd,
    encoding: 'utf8',
    env,
  });
}

async function createGitFixture(
  options: { ignoredPath?: string } = {},
): Promise<{
  directory: string;
  npmMarker: string;
  path: string;
}> {
  const directory = await mkdtemp(join(process.cwd(), 'test/gate-local-'));
  const bin = join(directory, 'bin');
  const npmMarker = join(directory, 'npm-called');
  await mkdir(bin);
  await writeFile(
    join(directory, '.gitignore'),
    ['bin/', ...(options.ignoredPath ? [options.ignoredPath] : [])].join('\n') +
      '\n',
  );
  await writeFile(join(directory, 'tracked.txt'), 'clean\n');
  for (const args of [
    ['init', '--quiet', '--initial-branch=main'],
    ['config', 'user.name', 'LON-248 Test'],
    ['config', 'user.email', 'lon-248@example.invalid'],
    ['add', '.gitignore', 'tracked.txt'],
    ['commit', '--quiet', '-m', 'fixture base'],
  ]) {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(
      result.status,
      0,
      `git ${args.join(' ')} failed: ${result.stderr}`,
    );
  }
  const npm = join(bin, 'npm');
  await writeFile(
    npm,
    `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(npmMarker)}, 'called');\nprocess.stdout.write('# tests 1\\nIsolation-dependent tests skipped: 1\\n');\n`,
  );
  await chmod(npm, 0o755);
  return {
    directory,
    npmMarker,
    path: `${bin}${delimiter}${process.env.PATH ?? ''}`,
  };
}

function runGateLocal(fixture: {
  directory: string;
  path: string;
}): SpawnSyncReturns<string> {
  const gateLocal = new URL('../scripts/gate-local.mjs', import.meta.url)
    .pathname;
  return spawnSync(process.execPath, [gateLocal], {
    cwd: fixture.directory,
    encoding: 'utf8',
    env: { ...process.env, PATH: fixture.path },
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

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
