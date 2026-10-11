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
  parseTapSummary,
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
  assert.equal(
    testSuiteExitCode(
      0,
      parseTapSummary(
        'ok 1 - real verdict check # SKIP SKIP(isolation): real verdict check — missing systemd user scopes\n# tests 1\n# skipped 1\n# todo 0\n',
      ),
      false,
      true,
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
  assert.equal(
    testSuiteExitCode(
      0,
      parseTapSummary('# tests 1\n# skipped 0\n# todo 0\n'),
      false,
      false,
    ),
    0,
  );
});

test('TAP exit policy rejects zero tests and unapproved CI skips or todos', () => {
  assert.equal(
    testSuiteExitCode(
      0,
      parseTapSummary('# tests 0\n# skipped 0\n# todo 0\n'),
      false,
      false,
    ),
    1,
  );
  assert.equal(
    testSuiteExitCode(
      0,
      parseTapSummary(
        'ok 1 - ordinary skip # SKIP not isolation\n# tests 1\n# skipped 1\n# todo 0\n',
      ),
      false,
      true,
    ),
    1,
  );
  assert.equal(
    testSuiteExitCode(
      0,
      parseTapSummary(
        'ok 1 - ordinary todo # TODO\n# tests 1\n# skipped 0\n# todo 1\n',
      ),
      false,
      true,
    ),
    1,
  );
  assert.equal(
    testSuiteExitCode(
      0,
      parseTapSummary(
        'ok 1 - ordinary skip # SKIP not isolation\n# tests 1\n# skipped 1\n# todo 0\n',
      ),
      false,
      false,
    ),
    0,
  );
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
    `import { test } from 'node:test';\nimport { requiresIsolation } from ${JSON.stringify(helperUrl)};\ntest('reported isolation fixture', (t) => { if (!requiresIsolation(t, 'exact isolation fixture name', ['systemdUserScope'])) return; throw new Error('missing systemd capability was used'); });\n`,
  );
  const env = {
    ...ciTestEnv(),
    GITHUB_STEP_SUMMARY: stepSummary,
  };

  try {
    const result = runTestSuite([fixture], directory, env);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^# skipped 1$/mu);
    assert.match(
      result.stdout,
      /Isolation-dependent tests skipped: 1[\s\S]*reported isolation fixture/u,
    );
    assert.equal(
      await pathExists(stepSummary),
      true,
      'CI test runner did not write GITHUB_STEP_SUMMARY',
    );
    const summary = await readFile(stepSummary, 'utf8');
    assert.match(summary, /Isolation-dependent tests skipped: 1/u);
    assert.match(summary, /reported isolation fixture/u);
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
  assert.equal(
    testSuiteExitCode(
      0,
      parseTapSummary(
        'ok 1 - isolated test # SKIP SKIP(isolation): isolated test — missing bwrap user namespaces\n# tests 1\n# skipped 1\n# todo 0\n',
      ),
      true,
      false,
    ),
    1,
  );

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
