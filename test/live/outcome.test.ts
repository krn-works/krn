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

async function repoFixture(): Promise<string> {
  const root = await mkdtemp(
    join(process.cwd(), '.krn/tmp/live-outcome-repo-'),
  );
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
  const script = new URL('../../scripts/live-l1.mjs', import.meta.url).pathname;
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
  const script = new URL('../../scripts/live-l1.mjs', import.meta.url).pathname;
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
