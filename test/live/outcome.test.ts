import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { stateDirectory } from '../../src/foreman/state.ts';
import * as relay from '../../src/relay/index.ts';
import { requiresIsolation } from '../helpers/isolation.ts';
import { systemdEnvironment as createSystemdEnvironment } from '../helpers/systemd-environment.ts';

async function repoFixture(): Promise<string> {
  const scratch = join(process.cwd(), '.krn/tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'live-outcome-repo-'));
  const run = (args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  };
  run(['init', '-q', '--initial-branch=main']);
  await writeFile(join(root, '.gitignore'), '.krn/\n');
  await writeFile(join(root, 'README.md'), 'fixture\n');
  run(['add', '.gitignore', 'README.md']);
  run([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  run(['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']);
  return root;
}

async function liveIssue(issue: string) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: issue,
        title: 'Outcome fixture',
        description: [
          '```krn-contract',
          JSON.stringify({
            version: 1,
            targetRepo: 'fixture/repo',
            checks: ['gate'],
          }),
          '```',
        ].join('\n'),
        updatedAt: '2026-10-18T18:00:00.000Z',
        status: 'in_progress',
        assigneeAgentId: 'fixture-agent',
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForTraceEvent(
  path: string,
  kind: string,
  timeoutMs = 10_000,
): Promise<Array<{ kind: string; data: Record<string, unknown> }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = (await readFile(path, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { kind: string; data: Record<string, unknown> },
      );
    if (rows.some((row) => row.kind === kind)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for trace event ${kind}`);
}

function startLive(
  root: string,
  jobId: string,
  issue: string,
  apiUrl: string,
  extraEnv: Record<string, string> = {},
) {
  const script = new URL('../../scripts/delivery-live.mjs', import.meta.url)
    .pathname;
  return spawn(
    process.execPath,
    [
      script,
      '--http',
      '--repo',
      root,
      '--worktree',
      root,
      '--job',
      jobId,
      '--issue',
      issue,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        KRN_LIVE: '1',
        KRN_PAPERCLIP_API_URL: apiUrl,
        KRN_PAPERCLIP_TOKEN: 'fixture-token',
        KRN_SESSION: 'fixture-session',
        KRN_LIVE_WALL_TIME_MS: '30000',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function startLiveWithPaperclipCli(
  root: string,
  jobId: string,
  issue: string,
  extraEnv: Record<string, string>,
) {
  const script = new URL('../../scripts/delivery-live.mjs', import.meta.url)
    .pathname;
  return spawn(
    process.execPath,
    [script, '--repo', root, '--job', jobId, '--issue', issue],
    {
      cwd: root,
      env: {
        ...process.env,
        KRN_LIVE: '1',
        KRN_SESSION: 'paperclip-cleanup-fixture',
        KRN_LIVE_WALL_TIME_MS: '30000',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

type ProcIdentity = { state: string; startTicks: string };

type PaperclipScope = {
  unit: string;
  controlGroup: string;
  pid: number;
  startTicks: string;
};

function procIdentity(pid: number): ProcIdentity | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw
      .slice(raw.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/u);
    const state = fields[0];
    const startTicks = fields[19];
    return state === undefined || startTicks === undefined
      ? undefined
      : { state, startTicks };
  } catch {
    return undefined;
  }
}

function systemdEnvironment(): NodeJS.ProcessEnv {
  return createSystemdEnvironment();
}

function paperclipUnitSnapshot(unit: string) {
  const shown = spawnSync(
    '/usr/bin/systemctl',
    [
      '--user',
      'show',
      '--property=ActiveState',
      '--property=ControlGroup',
      '--value',
      unit,
    ],
    { encoding: 'utf8', timeout: 5000, env: systemdEnvironment() },
  );
  if (shown.status !== 0)
    return {
      status: shown.status,
      active: '',
      controlGroup: '',
      pids: [] as number[],
      events: '',
    };
  const [active = '', controlGroup = ''] = shown.stdout
    .trimEnd()
    .split(/\r?\n/u);
  let pids: number[] = [];
  let events = '';
  if (controlGroup.startsWith('/') && !controlGroup.split('/').includes('..')) {
    const cgroup = join('/sys/fs/cgroup', controlGroup.slice(1));
    try {
      pids = readFileSync(join(cgroup, 'cgroup.procs'), 'utf8')
        .trim()
        .split(/\s+/u)
        .filter(Boolean)
        .map(Number);
    } catch {}
    try {
      events = readFileSync(join(cgroup, 'cgroup.events'), 'utf8').trim();
    } catch {}
  }
  return { status: shown.status, active, controlGroup, pids, events };
}

async function waitForPaperclipScopes(
  unitPath: string,
  startedPath: string,
  timeoutMs = 15_000,
): Promise<PaperclipScope[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const units = [
        ...new Set(
          (await readFile(unitPath, 'utf8'))
            .trim()
            .split(/\r?\n/u)
            .filter(Boolean),
        ),
      ];
      const started = (await readFile(startedPath, 'utf8'))
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { pid: number; startTicks: string });
      if (units.length >= 2 && started.length >= 2) {
        const registrations: PaperclipScope[] = [];
        for (const unit of units.slice(0, 2)) {
          const snapshot = paperclipUnitSnapshot(unit);
          if (
            snapshot.status !== 0 ||
            snapshot.active !== 'active' ||
            !snapshot.controlGroup.endsWith(unit)
          )
            break;
          const identity = started.find(
            (candidate) =>
              snapshot.pids.includes(candidate.pid) &&
              procIdentity(candidate.pid)?.startTicks === candidate.startTicks,
          );
          if (!identity) break;
          registrations.push({
            unit,
            controlGroup: snapshot.controlGroup,
            pid: identity.pid,
            startTicks: identity.startTicks,
          });
        }
        if (registrations.length === 2) return registrations;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    'two active Paperclip scopes with exact process identities were not observed',
  );
}

async function stopAndVerifyPaperclipScopes(
  units: readonly string[],
  identities: readonly { pid: number; startTicks: string }[],
): Promise<unknown[]> {
  const env = systemdEnvironment();
  for (const unit of units) {
    spawnSync(
      '/usr/bin/systemctl',
      ['--user', 'kill', '--kill-who=all', '--signal=SIGKILL', unit],
      { encoding: 'utf8', timeout: 5000, env },
    );
    spawnSync('/usr/bin/systemctl', ['--user', 'stop', unit], {
      encoding: 'utf8',
      timeout: 5000,
      env,
    });
  }
  const deadline = Date.now() + 10_000;
  let verified: unknown[] = [];
  while (Date.now() < deadline) {
    verified = units.map((unit) => {
      const snapshot = paperclipUnitSnapshot(unit);
      const identity = identities.find((candidate) =>
        snapshot.pids.includes(candidate.pid),
      );
      const processGone = identities
        .filter((candidate) => !identity || candidate.pid === identity.pid)
        .every((candidate) => {
          const stat = procIdentity(candidate.pid);
          return (
            !stat ||
            stat.startTicks !== candidate.startTicks ||
            stat.state === 'Z' ||
            stat.state === 'X'
          );
        });
      const scopeGone =
        snapshot.status !== 0 ||
        (['inactive', 'failed'].includes(snapshot.active) &&
          snapshot.pids.length === 0) ||
        /(^|\n)populated 0(\n|$)/u.test(snapshot.events);
      return { unit, ...snapshot, processGone, scopeGone };
    });
    if (
      verified.every(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          'processGone' in entry &&
          entry.processGone === true &&
          'scopeGone' in entry &&
          entry.scopeGone === true,
      ) &&
      identities.every((identity) => {
        const stat = procIdentity(identity.pid);
        return (
          !stat ||
          stat.startTicks !== identity.startTicks ||
          stat.state === 'Z' ||
          stat.state === 'X'
        );
      })
    )
      return verified;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `owned Paperclip scopes did not stop: ${JSON.stringify(verified)}`,
  );
}

async function runPaperclipStopScenario(
  scenario: string,
  failShow: boolean,
): Promise<{
  scenario: string;
  exitCode: number | null;
  output: unknown;
  registrations: PaperclipScope[];
  injectedFailures: string[];
  cleanup: unknown[];
}> {
  const root = await repoFixture();
  const scratch = join(process.cwd(), '.krn/tmp');
  const fakeDirectory = await mkdtemp(join(scratch, 'live-paperclip-scope-'));
  const fakeBin = join(fakeDirectory, 'bin');
  const unitsPath = join(fakeDirectory, 'units');
  const startedPath = join(fakeDirectory, 'started.jsonl');
  const failUnitPath = join(fakeDirectory, 'fail-show-unit');
  const failureLogPath = join(fakeDirectory, 'show-failures');
  const fakePaperclip = join(fakeBin, 'paperclip');
  const fakeSystemdRun = join(fakeBin, 'systemd-run');
  const fakeSystemctl = join(fakeBin, 'systemctl');
  await mkdir(fakeBin);
  await writeFile(
    fakePaperclip,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const raw = readFileSync('/proc/self/stat', 'utf8');
const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\\s+/u);
appendFileSync(process.env.PAPERCLIP_TEST_STARTED_FILE, JSON.stringify({ pid: process.pid, startTicks: fields[19], args: process.argv.slice(2) }) + '\\n');
setInterval(() => {}, 1000);
`,
  );
  await writeFile(
    fakeSystemdRun,
    `#!/bin/sh
previous=""
for arg in "$@"; do
  if [ "$previous" = "--unit" ]; then
    case "$arg" in krn-paperclip-*.scope) printf "%s\\n" "$arg" >> ${JSON.stringify(unitsPath)};; esac
  fi
  previous="$arg"
done
exec /usr/bin/systemd-run "$@"
`,
  );
  await writeFile(
    fakeSystemctl,
    `#!/bin/sh
if [ "$1" = "--user" ] && [ "$2" = "show" ]; then
  for arg in "$@"; do case "$arg" in krn-paperclip-*.scope) unit="$arg";; esac; done
  expected=$(cat ${JSON.stringify(failUnitPath)} 2>/dev/null)
  if [ -n "$expected" ] && [ "$unit" = "$expected" ]; then
    printf "%s\\n" "$unit" >> ${JSON.stringify(failureLogPath)}
    printf "injected registered-scope verification failure\\n" >&2
    exit 42
  fi
fi
exec /usr/bin/systemctl "$@"
`,
  );
  await Promise.all(
    [fakePaperclip, fakeSystemdRun, fakeSystemctl].map((path) =>
      chmod(path, 0o755),
    ),
  );

  const jobId = `paperclip-cleanup-${scenario}`;
  const child = startLiveWithPaperclipCli(root, jobId, 'F3-ISSUE', {
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    PAPERCLIP_TEST_UNIT_FILE: unitsPath,
    PAPERCLIP_TEST_STARTED_FILE: startedPath,
    PAPERCLIP_TEST_FAIL_UNIT_FILE: failUnitPath,
    PAPERCLIP_TEST_FAILURE_LOG: failureLogPath,
  });
  const resultPromise = collect(child);
  let registrations: PaperclipScope[] = [];
  const cleanup: unknown[] = [];
  try {
    registrations = await waitForPaperclipScopes(unitsPath, startedPath);
    const firstRegistration = registrations[0];
    assert.ok(firstRegistration, 'first Paperclip scope is registered');
    if (failShow) await writeFile(failUnitPath, `${firstRegistration.unit}\n`);
    child.kill('SIGTERM');
    const result = await resultPromise;
    const output = JSON.parse(result.stdout.trim()) as unknown;
    const injectedFailures = (
      await readFile(failureLogPath, 'utf8').catch(() => '')
    )
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean);
    const fixtureStatus = spawnSync('git', ['-C', root, 'status', '--short'], {
      encoding: 'utf8',
    });
    assert.equal(fixtureStatus.status, 0, fixtureStatus.stderr);
    assert.equal(
      fixtureStatus.stdout.trim(),
      '',
      'fixture repository remains clean',
    );
    return {
      scenario,
      exitCode: result.code,
      output,
      registrations,
      injectedFailures,
      cleanup,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const stopped = await Promise.race([
        resultPromise.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 8000),
        ),
      ]);
      if (!stopped) child.kill('SIGKILL');
      await resultPromise.catch(() => undefined);
    }
    const units = (await readFile(unitsPath, 'utf8').catch(() => ''))
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean);
    const identities = (await readFile(startedPath, 'utf8').catch(() => ''))
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { pid: number; startTicks: string });
    try {
      cleanup.push(...(await stopAndVerifyPaperclipScopes(units, identities)));
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(fakeDirectory, { recursive: true, force: true }),
      ]);
    }
  }
}

test('live-l1 reports Paperclip scope cleanup verification failures as setup errors', {
  timeout: 60_000,
}, async (t) => {
  if (
    !requiresIsolation(
      t,
      'live-l1 reports Paperclip scope cleanup verification failures as setup errors',
      ['systemdUserScope'],
    )
  )
    return;
  const control = await runPaperclipStopScenario('control', false);
  const failure = await runPaperclipStopScenario('failure', true);
  const controlOutput = control.output as {
    outcome: { kind: string; phase: string };
    error: unknown;
  };
  const failureOutput = failure.output as {
    outcome: { kind: string; phase: string };
    error: { type?: string } | null;
  };
  t.diagnostic(
    JSON.stringify({
      control: {
        exitCode: control.exitCode,
        output: controlOutput,
        registrations: control.registrations,
        cleanup: control.cleanup,
      },
      failure: {
        exitCode: failure.exitCode,
        output: failureOutput,
        registrations: failure.registrations,
        injectedFailures: failure.injectedFailures,
        cleanup: failure.cleanup,
      },
    }),
  );
  assert.equal(control.registrations.length, 2);
  assert.deepEqual(control.injectedFailures, []);
  assert.equal(control.exitCode, 130);
  assert.deepEqual(controlOutput, {
    outcome: { kind: 'stopped', phase: 'setup' },
    error: null,
  });
  assert.equal(failure.registrations.length, 2);
  const failedRegistration = failure.registrations[0];
  assert.ok(failedRegistration);
  assert.deepEqual(failure.injectedFailures, [failedRegistration.unit]);
  assert.equal(failure.exitCode, 1);
  assert.deepEqual(failureOutput, {
    outcome: { kind: 'error', phase: 'setup' },
    error: { type: 'CleanupError' },
  });
  for (const scenario of [control, failure]) {
    assert.equal(scenario.cleanup.length, 2);
    assert.ok(
      scenario.cleanup.every(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          'scopeGone' in entry &&
          entry.scopeGone === true &&
          'processGone' in entry &&
          entry.processGone === true,
      ),
      JSON.stringify(scenario.cleanup),
    );
  }
});

async function installRunJobHook(root: string): Promise<string> {
  const hook = join(root, 'runjob-hook.mjs');
  const replacement = `data:text/javascript,${encodeURIComponent(
    [
      'const mode = process.env.KRN_TEST_RUNJOB_MODE;',
      'export async function runJob() {',
      "  process.stderr.write('RUNJOB_TEST_HOOK\\n');",
      "  if (mode === 'complete') return { kind: 'review' };",
      '  const rejected = { false: false, null: null, undefined, zero: 0, empty: "" };',
      '  throw rejected[mode];',
      '}',
    ].join('\n'),
  )}`;
  await writeFile(
    hook,
    [
      "import { registerHooks } from 'node:module';",
      'const target = process.env.KRN_TEST_RUNJOB_URL;',
      `const replacement = ${JSON.stringify(replacement)};`,
      'registerHooks({ resolve(specifier, context, nextResolve) {',
      '  const result = nextResolve(specifier, context);',
      '  if (result.url === target) return { url: replacement, shortCircuit: true };',
      '  return result;',
      '} });',
      '',
    ].join('\n'),
  );
  return hook;
}

async function collect(process: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  let stdout = '';
  let stderr = '';
  process.stdout?.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  process.stderr?.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    process.once('close', (code, signal) => resolve({ code, signal })),
  );
  return { code, signal, stdout, stderr };
}

function processIdentityAlive(pid: number, startTicks: string): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/u);
    return fields[0] !== 'Z' && fields[0] !== 'X' && fields[19] === startTicks;
  } catch {
    return false;
  }
}

test('live-l1 fails on every falsy runJob rejection and preserves completion', async () => {
  const root = await repoFixture();
  const issue = 'I-OUTCOME-FALSY';
  const api = await liveIssue(issue);
  const hook = await installRunJobHook(root);
  const fakeCodex = join(root, 'fake-codex');
  const codexCalled = join(root, 'fake-codex-called');
  await writeFile(
    fakeCodex,
    `#!/bin/sh\n: > ${JSON.stringify(codexCalled)}\nexit 97\n`,
  );
  await chmod(fakeCodex, 0o755);
  const runJobUrl = new URL('../../src/foreman/run.ts', import.meta.url).href;
  const cases = [
    { mode: 'false', type: 'boolean' },
    { mode: 'null', type: 'object' },
    { mode: 'undefined', type: 'Error' },
    { mode: 'zero', type: 'number' },
    { mode: 'empty', type: 'string' },
  ];
  const observed: unknown[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  try {
    for (const candidate of cases) {
      const jobId = `outcome-falsy-${candidate.mode}`;
      child = startLive(root, jobId, issue, api.apiUrl, {
        KRN_CODEX_BIN: fakeCodex,
        KRN_TEST_RUNJOB_MODE: candidate.mode,
        KRN_TEST_RUNJOB_URL: runJobUrl,
        NODE_OPTIONS: `--import=${hook}`,
      });
      const result = await collect(child);
      const printed = JSON.parse(result.stdout.trim()) as {
        error?: { type?: string };
        outcome?: unknown;
      };
      const job = { id: jobId, issue, worktree: root, repoRoot: root };
      const rows = (
        await readFile(join(stateDirectory(job), 'trace.jsonl'), 'utf8')
      )
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as { kind: string; data: Record<string, unknown> },
        );
      const outcome = rows.findLast((row) => row.kind === 'job_outcome');
      observed.push({
        mode: candidate.mode,
        processExit: result.code,
        traceExit: outcome?.data.exitCode,
        traceReason: outcome?.data.reason,
        traceCleanup: outcome?.data.cleanup,
        traceErrorType: (outcome?.data.error as { type?: string } | undefined)
          ?.type,
        cliErrorType: printed.error?.type,
        cliOutcome: printed.outcome,
        codexCalled: await access(codexCalled)
          .then(() => true)
          .catch(() => false),
        hookUsed: result.stderr.includes('RUNJOB_TEST_HOOK'),
      });
      child = undefined;
    }

    const jobId = 'outcome-falsy-completion';
    child = startLive(root, jobId, issue, api.apiUrl, {
      KRN_CODEX_BIN: fakeCodex,
      KRN_TEST_RUNJOB_MODE: 'complete',
      KRN_TEST_RUNJOB_URL: runJobUrl,
      NODE_OPTIONS: `--import=${hook}`,
    });
    const result = await collect(child);
    const printed = JSON.parse(result.stdout.trim()) as {
      error?: unknown;
      outcome?: { kind?: string };
    };
    const job = { id: jobId, issue, worktree: root, repoRoot: root };
    const rows = (
      await readFile(join(stateDirectory(job), 'trace.jsonl'), 'utf8')
    )
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { kind: string; data: Record<string, unknown> },
      );
    const outcome = rows.findLast((row) => row.kind === 'job_outcome');
    observed.push({
      mode: 'complete',
      processExit: result.code,
      traceExit: outcome?.data.exitCode,
      traceReason: outcome?.data.reason,
      traceCleanup: outcome?.data.cleanup,
      traceOutcomeKind: outcome?.data.outcomeKind,
      cliOutcome: printed.outcome,
      cliError: printed.error,
      codexCalled: await access(codexCalled)
        .then(() => true)
        .catch(() => false),
      hookUsed: result.stderr.includes('RUNJOB_TEST_HOOK'),
    });
    child = undefined;

    assert.deepEqual(observed, [
      ...cases.map((candidate) => ({
        mode: candidate.mode,
        processExit: 1,
        traceExit: 1,
        traceReason: 'runjob-error',
        traceCleanup: 'verified',
        traceErrorType: candidate.type,
        cliErrorType: candidate.type,
        cliOutcome: null,
        codexCalled: false,
        hookUsed: true,
      })),
      {
        mode: 'complete',
        processExit: 0,
        traceExit: 0,
        traceReason: 'completed',
        traceCleanup: 'verified',
        traceOutcomeKind: 'review',
        cliOutcome: { kind: 'review' },
        cliError: undefined,
        codexCalled: false,
        hookUsed: true,
      },
    ]);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await Promise.all([
      api.close(),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});

test('live-l1 records a bounded error outcome when runJob rejects', async () => {
  const root = await repoFixture();
  const issue = 'I-OUTCOME-ERROR';
  const jobId = 'outcome-error';
  const api = await liveIssue(issue);
  const job = { id: jobId, issue, worktree: root, repoRoot: root };
  const maliciousName = `ghp_${'A'.repeat(36)}`;
  const preload = join(root, 'malicious-error-name.mjs');
  await writeFile(
    preload,
    `Object.defineProperty(Error.prototype, 'name', { configurable: true, get() { return ${JSON.stringify(maliciousName)}; } });\n`,
  );
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await relay.load(job, { revision: 'stale-contract-revision' });
    child = startLive(root, jobId, issue, api.apiUrl, {
      NODE_OPTIONS: `--import=${preload}`,
    });
    const result = await collect(child);
    const tracePath = join(stateDirectory(job), 'trace.jsonl');
    const rows = (await readFile(tracePath, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { kind: string; data: Record<string, unknown> },
      );
    const outcome = rows.findLast((row) => row.kind === 'job_outcome');
    const printedError = result.stdout
      .trim()
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line) as { error?: { type?: string } };
        } catch {
          return {};
        }
      })
      .find((line) => line.error !== undefined)?.error;
    const checks = [
      { name: 'runJob error exits 1', pass: result.code === 1 },
      {
        name: 'live-l1 prints structured JSON',
        pass: result.stdout
          .trim()
          .split('\n')
          .some((line) => {
            try {
              JSON.parse(line);
              return true;
            } catch {
              return false;
            }
          }),
      },
      {
        name: 'final trace outcome records the error',
        pass:
          outcome?.data.reason === 'runjob-error' &&
          outcome.data.cleanup === 'verified' &&
          (outcome.data.error as { type?: string } | undefined)?.type ===
            'Error',
      },
      {
        name: 'live-l1 JSON uses the same safe error type',
        pass: printedError?.type === 'Error',
      },
      {
        name: 'credential-shaped type is absent from trace and stdout',
        pass:
          !JSON.stringify(rows).includes(maliciousName) &&
          !result.stdout.includes(maliciousName),
      },
      {
        name: 'outcome does not contain a stack',
        pass: !(JSON.stringify(outcome) ?? '').includes('stack'),
      },
    ];
    assert.deepEqual(
      checks.filter((check) => !check.pass),
      [],
      `${JSON.stringify(checks)}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await api.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('live-l1 reports setup errors without creating a job trace', async () => {
  const root = await repoFixture();
  const jobId = 'outcome-setup-error';
  const script = new URL('../../scripts/delivery-live.mjs', import.meta.url)
    .pathname;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(
      process.execPath,
      [
        script,
        '--repo',
        root,
        '--worktree',
        join(root, 'missing-worktree'),
        '--job',
        jobId,
        '--issue',
        'I-OUTCOME-SETUP',
      ],
      {
        cwd: root,
        env: { ...process.env, KRN_LIVE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const result = await collect(child);
    assert.equal(result.code, 1, result.stderr);
    const output = JSON.parse(result.stdout.trim()) as {
      outcome: { kind: string; phase: string };
      error: { type: string };
    };
    assert.deepEqual(output.outcome, { kind: 'error', phase: 'setup' });
    assert.equal(output.error.type, 'SetupError');
    await assert.rejects(access(join(root, '.krn', 'runs', 'foreman', jobId)), {
      code: 'ENOENT',
    });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

test('live-l1 reports a verified setup SIGTERM as stopped with exit 130', {
  timeout: 20_000,
}, async () => {
  const root = await repoFixture();
  const issue = 'I-OUTCOME-SETUP-STOP';
  const jobId = 'outcome-setup-stop';
  const api = await liveIssue(issue);
  const scratch = join(process.cwd(), '.krn/tmp');
  await mkdir(scratch, { recursive: true });
  const fakeBin = await mkdtemp(join(scratch, 'live-setup-stop-bin-'));
  const marker = join(fakeBin, 'check-ignore-started');
  await writeFile(
    join(fakeBin, 'git'),
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = check-ignore ]; then
    : > ${JSON.stringify(marker)}
    exec /bin/sleep 120
  fi
done
exec /usr/bin/git "$@"
`,
  );
  await chmod(join(fakeBin, 'git'), 0o755);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = startLive(root, jobId, issue, api.apiUrl, {
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    });
    const resultPromise = collect(child);
    await waitForFile(marker);
    child.kill('SIGTERM');
    const result = await resultPromise;
    assert.equal(result.code, 130, `${result.stdout}\n${result.stderr}`);
    const output = JSON.parse(result.stdout.trim()) as {
      outcome: { kind: string; phase: string };
      error: unknown;
    };
    assert.deepEqual(output.outcome, { kind: 'stopped', phase: 'setup' });
    assert.equal(output.error, null);
    await assert.rejects(
      access(join(root, '.krn', 'runs', 'foreman', jobId)),
      { code: 'ENOENT' },
      'setup cancellation before job creation must not invent a durable job',
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await Promise.all([
      api.close(),
      rm(root, { recursive: true, force: true }),
      rm(fakeBin, { recursive: true, force: true }),
    ]);
  }
});

test('live-l1 reports unconfirmed native scope teardown as failure', {
  timeout: 60_000,
}, async (t) => {
  if (
    !requiresIsolation(t, 'live unconfirmed native scope teardown', [
      'bwrap',
      'systemdUserScope',
    ])
  )
    return;
  const root = await repoFixture();
  const issue = 'I-OUTCOME-STOP';
  const jobId = 'outcome-stop';
  const api = await liveIssue(issue);
  const scratch = join(process.cwd(), '.krn/tmp');
  const fakeBin = await mkdtemp(join(scratch, 'live-outcome-bin-'));
  const fixtureState = join(root, '.krn', 'tmp');
  await mkdir(fixtureState, { recursive: true });
  const registered = join(fixtureState, 'registered');
  const running = join(fixtureState, 'codex-running');
  const failShow = join(fakeBin, 'fail-show');
  const fakeSystemctl = join(fakeBin, 'systemctl');
  const fakeCodex = join(root, 'fake-codex');
  await writeFile(
    fakeSystemctl,
    `#!/bin/sh
case "$*" in
  *" show "*krn-${jobId}-*)
    if [ -f ${JSON.stringify(failShow)} ]; then exit 1; fi
    /usr/bin/systemctl "$@"
    status=$?
    if [ "$status" -eq 0 ]; then : > ${JSON.stringify(registered)}; fi
    exit "$status"
    ;;
esac
exec /usr/bin/systemctl "$@"
`,
  );
  await writeFile(
    fakeCodex,
    `#!/bin/sh
while [ ! -f ${JSON.stringify(registered)} ]; do /bin/sleep 0.01; done
/bin/touch ${JSON.stringify(running)}
/usr/bin/printf '{"type":"turn.started"}\\n'
while :; do /bin/sleep 1; done
`,
  );
  await Promise.all([chmod(fakeSystemctl, 0o755), chmod(fakeCodex, 0o755)]);
  const stagedCodex = spawnSync('git', ['-C', root, 'add', 'fake-codex'], {
    encoding: 'utf8',
  });
  assert.equal(stagedCodex.status, 0, stagedCodex.stderr);
  const committedCodex = spawnSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'test: add fake codex executable',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(committedCodex.status, 0, committedCodex.stderr);
  let child: ReturnType<typeof spawn> | undefined;
  let unit: string | undefined;
  let registration:
    | { unit: string; pid: number; startTicks: string }
    | undefined;
  try {
    child = startLive(root, jobId, issue, api.apiUrl, {
      KRN_CODEX_BIN: fakeCodex,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    });
    const resultPromise = collect(child);
    try {
      await waitForFile(running);
    } catch (error) {
      child.kill('SIGKILL');
      const result = await resultPromise;
      const job = { id: jobId, issue, worktree: root, repoRoot: root };
      const traceText = await readFile(
        join(stateDirectory(job), 'trace.jsonl'),
        'utf8',
      ).catch(() => '');
      throw new Error(
        `${String(error)}\nstdout=${result.stdout}\nstderr=${result.stderr}\ntrace=${traceText}`,
      );
    }
    const job = { id: jobId, issue, worktree: root, repoRoot: root };
    const tracePath = join(stateDirectory(job), 'trace.jsonl');
    const startedRows = await waitForTraceEvent(tracePath, 'session_started');
    registration = startedRows.find((row) => row.kind === 'session_started')
      ?.data.scopeRegistration as
      | { unit: string; pid: number; startTicks: string }
      | undefined;
    unit = registration?.unit;
    assert.ok(
      unit,
      'native session registration must be durable before interruption',
    );
    await writeFile(failShow, '1');
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM');
    const result = await resultPromise;
    const rows = (await readFile(tracePath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { kind: string; data: Record<string, unknown> },
      );
    const outcome = rows.findLast((row) => row.kind === 'job_outcome');
    assert.equal(
      result.code,
      1,
      `${result.signal}: ${result.stdout}\n${result.stderr}`,
    );
    assert.ok(rows.some((row) => row.kind === 'teardown_unconfirmed'));
    assert.equal(outcome?.data.cleanup, 'unconfirmed');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    if (!unit) {
      try {
        const job = { id: jobId, issue, worktree: root, repoRoot: root };
        const tracePath = join(stateDirectory(job), 'trace.jsonl');
        const rows = (await readFile(tracePath, 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map(
            (line) =>
              JSON.parse(line) as {
                kind: string;
                data: Record<string, unknown>;
              },
          );
        registration = rows.find((row) => row.kind === 'session_started')?.data
          .scopeRegistration as
          | { unit: string; pid: number; startTicks: string }
          | undefined;
        unit = registration?.unit;
      } catch {}
    }
    if (unit) {
      const killed = spawnSync(
        '/usr/bin/systemctl',
        ['--user', 'kill', '--kill-who=all', '--signal=SIGKILL', unit],
        { encoding: 'utf8', timeout: 5000 },
      );
      const stopped = spawnSync(
        '/usr/bin/systemctl',
        ['--user', 'stop', unit],
        { encoding: 'utf8', timeout: 10000 },
      );
      const active = spawnSync(
        '/usr/bin/systemctl',
        ['--user', 'is-active', unit],
        { encoding: 'utf8', timeout: 5000 },
      );
      if (
        registration &&
        processIdentityAlive(registration.pid, registration.startTicks)
      ) {
        try {
          process.kill(registration.pid, 'SIGKILL');
        } catch {}
      }
      const processStillAlive = registration
        ? processIdentityAlive(registration.pid, registration.startTicks)
        : false;
      assert.notEqual(
        active.stdout.trim(),
        'active',
        `owned test unit ${unit} must be stopped`,
      );
      assert.equal(
        processStillAlive,
        false,
        `registered process for ${unit} must be gone`,
      );
      t.diagnostic(
        `test unit cleanup ${JSON.stringify({ unit, pid: registration?.pid, startTicks: registration?.startTicks, killStatus: killed.status, stopStatus: stopped.status, activeStatus: active.status, active: active.stdout.trim(), processStillAlive })}`,
      );
    }
    await Promise.all([
      api.close(),
      rm(root, { recursive: true, force: true }),
      rm(fakeBin, { recursive: true, force: true }),
    ]);
  }
});
