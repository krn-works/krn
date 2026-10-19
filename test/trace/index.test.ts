import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import type { Job } from '../../src/core/index.ts';
import { stateDirectory } from '../../src/foreman/state.ts';
import * as trace from '../../src/trace/index.ts';
import {
  classifyTraceFdPathReadback,
  failure,
  hasVerdict,
  traceFdPathVerificationDecision,
  verdict,
} from '../../src/trace/index.ts';
import type { VerdictEvent } from '../../src/verdict/index.ts';

async function fixture(): Promise<{
  job: Job;
  directory: string;
  tracePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'krn-trace-test-'));
  const initialized = spawnSync('git', ['-C', directory, 'init', '--quiet'], {
    encoding: 'utf8',
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const job: Job = {
    id: `trace-test-${randomUUID()}`,
    issue: 'LON-228',
    worktree: directory,
    repoRoot: directory,
  };
  return {
    job,
    directory,
    tracePath: join(stateDirectory(job), 'trace.jsonl'),
  };
}

function event(sha: string, exitCode: number, checkSha: string): VerdictEvent {
  return {
    sha,
    checks: [{ id: 'gate', exitCode, durationMs: 1, sha256: checkSha }],
  };
}

test('trace fd path readback refuses unavailable procfs and mismatch', () => {
  const expectedPath = '/repo/.krn/runs/foreman/job/trace.jsonl';
  const unavailable = classifyTraceFdPathReadback(
    undefined,
    'ENOENT',
    expectedPath,
  );
  assert.equal(unavailable, 'unavailable');
  assert.equal(traceFdPathVerificationDecision(unavailable), 'refusal');
  const unavailableParent = classifyTraceFdPathReadback(
    undefined,
    'ENOTDIR',
    expectedPath,
  );
  assert.equal(unavailableParent, 'unavailable');
  assert.equal(traceFdPathVerificationDecision(unavailableParent), 'refusal');
  const verified = classifyTraceFdPathReadback(
    expectedPath,
    undefined,
    expectedPath,
  );
  assert.equal(verified, 'verified');
  assert.equal(traceFdPathVerificationDecision(verified), 'ok');
  const mismatch = classifyTraceFdPathReadback(
    '/outside/trace.jsonl',
    undefined,
    expectedPath,
  );
  assert.equal(mismatch, 'mismatch');
  assert.equal(traceFdPathVerificationDecision(mismatch), 'refusal');
  const unreadable = classifyTraceFdPathReadback(
    undefined,
    'EACCES',
    expectedPath,
  );
  assert.equal(unreadable, 'mismatch');
  assert.equal(traceFdPathVerificationDecision(unreadable), 'refusal');
});

test('trace recovers and reports an incomplete tail but rejects completed corruption', async () => {
  const f = await fixture();
  const sha = 'a'.repeat(40);
  try {
    await verdict(f.job, event(sha, 0, 'b'.repeat(64)));
    await appendFile(f.tracePath, '{"key":"torn"');
    const beforeRead = await readFile(f.tracePath);

    let readable = false;
    let diagnostic = '';
    const originalWarn = console.warn;
    console.warn = (...values: unknown[]) => {
      diagnostic = values.map(String).join(' ');
    };
    try {
      try {
        readable = await hasVerdict(f.job, sha);
      } catch {
        readable = false;
      }
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(
      readable,
      true,
      'a torn tail must not hide the durable verdict',
    );
    assert.match(diagnostic, /torn final trace line/u);
    assert.deepEqual(
      await readFile(f.tracePath),
      beforeRead,
      'reading a torn tail must leave every trace byte unchanged',
    );
    await verdict(f.job, event('c'.repeat(40), 0, 'd'.repeat(64)));

    const later = JSON.stringify({
      key: 'later-valid-row',
      kind: 'verdict',
      at: new Date().toISOString(),
      data: { sha, checks: event(sha, 0, 'c'.repeat(64)).checks },
    });
    await appendFile(
      f.tracePath,
      `{"key":"broken","kind":"verdict","at":"now","data":}}\n${later}\n`,
    );
    await assert.rejects(hasVerdict(f.job, sha), SyntaxError);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('trace reads a valid unterminated final row without adding bytes', async () => {
  const f = await fixture();
  const sha = 'a'.repeat(40);
  try {
    await verdict(f.job, event(sha, 0, 'b'.repeat(64)));
    const bytes = await readFile(f.tracePath);
    assert.equal(bytes.at(-1), 0x0a);
    await writeFile(f.tracePath, bytes.subarray(0, -1));
    const beforeRead = await readFile(f.tracePath);

    assert.equal(await hasVerdict(f.job, sha), true);
    assert.deepEqual(
      await readFile(f.tracePath),
      beforeRead,
      'reading a valid unterminated row must not append a newline',
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('job outcomes redact credentials and bound error messages', async () => {
  const f = await fixture();
  type JobOutcomeWriter = (
    job: Job,
    input: {
      exitCode: number;
      signal: null;
      cleanup: 'verified';
      reason: 'runjob-error';
      error: Error;
    },
  ) => void;
  const writer = Reflect.get(trace, 'jobOutcome') as
    | JobOutcomeWriter
    | undefined;
  try {
    if (writer) {
      writer(f.job, {
        exitCode: 1,
        signal: null,
        cleanup: 'verified',
        reason: 'runjob-error',
        error: new Error('request failed with Bearer secret-value-123'),
      });
      writer(f.job, {
        exitCode: 1,
        signal: null,
        cleanup: 'verified',
        reason: 'runjob-error',
        error: new Error('x'.repeat(600)),
      });
    } else {
      await failure(f.job, 'outcome-redaction', new Error('probe'));
    }
    const rows = (await readFile(f.tracePath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            kind: string;
            data: { error?: { message: string } };
          },
      );
    const outcomes = rows.filter((row) => row.kind === 'job_outcome');
    assert.equal(outcomes.length, 2, 'both final outcomes must be recorded');
    assert.equal(outcomes[0]?.data.error?.message, '[redacted]');
    assert.equal(outcomes[1]?.data.error?.message.length, 240);
    assert.ok(!JSON.stringify(outcomes).includes('secret-value-123'));
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('error type fields preserve standard names and omit credential-bearing custom names', async () => {
  const f = await fixture();
  const githubName = `ghp_${'A'.repeat(36)}`;
  const awsName = `AKIA${'A'.repeat(16)}`;
  try {
    const githubError = new Error('ordinary GitHub failure');
    githubError.name = githubName;
    trace.jobOutcome(f.job, {
      exitCode: 1,
      signal: null,
      cleanup: 'verified',
      reason: 'runjob-error',
      error: githubError,
    });
    trace.jobOutcome(f.job, {
      exitCode: 1,
      signal: null,
      cleanup: 'verified',
      reason: 'runjob-error',
      error: new TypeError('ordinary public type'),
    });
    const awsError = new Error('ordinary AWS failure');
    awsError.name = awsName;
    await failure(f.job, 'error-type-redaction', awsError);

    const rows = (await readFile(f.tracePath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            kind: string;
            data: {
              error?: { type: string; message: string };
              errorType?: string;
            };
          },
      );
    const outcomes = rows.filter((row) => row.kind === 'job_outcome');
    const failed = rows.find((row) => row.kind === 'failure');
    assert.deepEqual(
      outcomes.map((row) => row.data.error?.type),
      ['Error', 'TypeError'],
      'credential-shaped custom names must map to the fixed public fallback',
    );
    assert.equal(outcomes[0]?.data.error?.message, 'ordinary GitHub failure');
    assert.equal(failed?.data.errorType, 'Error');
    assert.ok(
      !JSON.stringify(rows).includes(githubName),
      'GitHub-shaped type must not be persisted',
    );
    assert.ok(
      !JSON.stringify(rows).includes(awsName),
      'AWS-shaped type must not be persisted',
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('job outcomes persist a bounded safe fallback for unprintable rejection values', async () => {
  const f = await fixture();
  const noPrototype: unknown = Object.create(null);
  const throwingCoercion = Object.defineProperty({}, Symbol.toPrimitive, {
    get() {
      throw new Error('private-coercion-value');
    },
  });
  const throwingInspection = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error('private-inspection-value');
      },
    },
  );
  const errors: unknown[] = [
    noPrototype,
    throwingCoercion,
    throwingInspection,
    new Error('request failed with Bearer private-message-value'),
    new TypeError('ordinary public failure'),
  ];
  const rejectedWrites: unknown[] = [];
  try {
    for (const error of errors) {
      try {
        trace.jobOutcome(f.job, {
          exitCode: 1,
          signal: null,
          cleanup: 'verified',
          reason: 'runjob-error',
          error,
        });
      } catch (writeError) {
        rejectedWrites.push(writeError);
      }
    }

    const rows = (await readFile(f.tracePath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            kind: string;
            data: { error?: { type: string; message: string } };
          },
      );
    const outcomes = rows.filter((row) => row.kind === 'job_outcome');
    assert.equal(
      rejectedWrites.length,
      0,
      'unprintable rejection values must not prevent outcome persistence',
    );
    assert.equal(outcomes.length, errors.length);
    assert.deepEqual(
      outcomes.map((row) => row.data.error?.type),
      ['object', 'object', 'Error', 'Error', 'TypeError'],
    );
    assert.deepEqual(
      outcomes.map((row) => row.data.error?.message),
      [
        'Error details unavailable',
        'Error details unavailable',
        'Error details unavailable',
        '[redacted]',
        'ordinary public failure',
      ],
    );
    assert.ok(
      !JSON.stringify(outcomes).includes('private-'),
      'rejected object internals and credential-bearing diagnostics must not leak',
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('concurrent trace.started callers return true only for the stored session row', {
  timeout: 15_000,
}, async () => {
  const f = await fixture();
  const barrier = join(f.directory, 'started-race');
  await mkdir(barrier);
  await mkdir(dirname(f.tracePath), { recursive: true });
  const jobFile = join(barrier, 'job.json');
  const child = join(barrier, 'started.mjs');
  const traceUrl = new URL('../../src/trace/index.ts', import.meta.url).href;
  await writeFile(jobFile, JSON.stringify(f.job));
  await writeFile(
    child,
    `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { started } from ${JSON.stringify(traceUrl)};
const job = JSON.parse(readFileSync(process.env.KRN_STARTED_RACE_JOB, 'utf8'));
const sessionId = process.env.KRN_STARTED_RACE_SESSION;
const root = process.env.KRN_STARTED_RACE_DIR;
const peer = sessionId === 'session-a' ? 'session-b' : 'session-a';
const ownReady = root + '/' + sessionId + '-ready';
const peerReady = root + '/' + peer + '-ready';
writeFileSync(ownReady, '1', { flag: 'wx' });
const until = Date.now() + 8000;
while (!existsSync(peerReady)) {
  if (Date.now() >= until) throw new Error('started-race barrier timed out waiting for peer');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
const accepted = await started(job, 'intent-race', sessionId);
process.stdout.write(JSON.stringify({ sessionId, accepted }) + '\\n');
`,
  );

  const run = (sessionId: string) =>
    spawn(process.execPath, [child], {
      cwd: f.directory,
      env: {
        ...process.env,
        KRN_STARTED_RACE_DIR: barrier,
        KRN_STARTED_RACE_TRACE: f.tracePath,
        KRN_STARTED_RACE_JOB: jobFile,
        KRN_STARTED_RACE_SESSION: sessionId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const first = run('session-a');
  const second = run('session-b');
  const collect = (process: ReturnType<typeof spawn>) =>
    new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      let stdout = '';
      let stderr = '';
      process.stdout?.setEncoding('utf8').on('data', (chunk) => {
        stdout += chunk;
      });
      process.stderr?.setEncoding('utf8').on('data', (chunk) => {
        stderr += chunk;
      });
      process.once('close', (code) => resolve({ code, stdout, stderr }));
    });
  try {
    const [firstResult, secondResult] = await Promise.all([
      collect(first),
      collect(second),
    ]);
    assert.equal(firstResult.code, 0, firstResult.stderr);
    assert.equal(secondResult.code, 0, secondResult.stderr);
    const results = [firstResult, secondResult].map(
      (result) =>
        JSON.parse(result.stdout.trim()) as {
          sessionId: string;
          accepted: boolean;
        },
    );
    const rows = (await readFile(f.tracePath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            key: string;
            kind: string;
            data: { sessionId?: string };
          },
      );
    const winner = rows.find((row) => row.key === 'intent-race:session');
    assert.equal(winner?.kind, 'session_started');
    assert.equal(
      results.filter((result) => result.accepted).length,
      1,
      'exactly the caller whose immutable row won may report acceptance',
    );
    assert.deepEqual(
      results
        .filter((result) => result.accepted)
        .map((result) => result.sessionId),
      [winner?.data.sessionId],
      'no caller may report a different session as durable',
    );
  } finally {
    for (const process of [first, second]) {
      if (process.exitCode === null && process.signalCode === null)
        process.kill('SIGKILL');
    }
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('trace.started confirms duplicate rows under the owned append lock', {
  timeout: 35_000,
}, async (t) => {
  const f = await fixture();
  const directory = join(f.directory, 'started-durability');
  await mkdir(directory);
  const jobFile = join(directory, 'job.json');
  const preloadFile = join(directory, 'preload.mjs');
  const workerFile = join(directory, 'started.mjs');
  const traceModuleUrl = new URL('../../src/trace/index.ts', import.meta.url)
    .href;
  await writeFile(jobFile, JSON.stringify(f.job));
  await writeFile(
    preloadFile,
    `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const tracePath = process.env.KRN_TRACE_DURABILITY_TRACE;
const role = process.env.KRN_TRACE_DURABILITY_ROLE;
const readyPath = process.env.KRN_TRACE_DURABILITY_READY;
const releasePath = process.env.KRN_TRACE_DURABILITY_RELEASE;
const fsyncSeenPath = process.env.KRN_TRACE_DURABILITY_FSYNC_SEEN;
const originalFsyncSync = fs.fsyncSync;
let intercepted = false;
function startTicks(pid) {
  const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/u);
  return fields[19];
}
function writeJson(path, value) {
  fs.writeFileSync(path, JSON.stringify(value) + '\\n', { flag: 'wx', mode: 0o600 });
}
fs.fsyncSync = function (fd) {
  let actualPath;
  try { actualPath = fs.readlinkSync('/proc/' + process.pid + '/fd/' + fd); }
  catch { return originalFsyncSync(fd); }
  if (actualPath !== tracePath || intercepted)
    return originalFsyncSync(fd);
  intercepted = true;
  if (role === 'owner-pause') {
    const bytes = fs.readFileSync(tracePath);
    const rows = bytes.toString('utf8').trimEnd().split('\\n').map((line) => JSON.parse(line));
    const row = rows.find((event) => event.key === 'intent-durable:session');
    if (!row || row.data.sessionId !== 'session-durable')
      throw new Error('owned trace row was not visible at exact-fd fsync');
    let lock = null;
    try { lock = JSON.parse(fs.readFileSync(tracePath + '.lock', 'utf8')); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    writeJson(readyPath, {
      pid: process.pid,
      startTicks: startTicks(process.pid),
      tracePath: actualPath,
      traceBytes: bytes.length,
      rowKey: row.key,
      rowSessionId: row.data.sessionId,
      lock,
    });
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(releasePath)) {
        const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
        if (release.pid !== process.pid || release.startTicks !== startTicks(process.pid))
          throw new Error('release marker did not identify the fsync owner');
        const error = new Error('fixture-only trace fsync failure');
        error.code = 'EIO';
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    throw new Error('timed out waiting for owned trace fsync release');
  }
  if (role === 'duplicate-fsync-eio') {
    writeJson(fsyncSeenPath, {
      pid: process.pid,
      startTicks: startTicks(process.pid),
      tracePath: actualPath,
    });
    const error = new Error('fixture-only duplicate trace fsync failure');
    error.code = 'EIO';
    throw error;
  }
  return originalFsyncSync(fd);
};
syncBuiltinESMExports();
`,
  );
  await writeFile(
    workerFile,
    `
import fs from 'node:fs';
import { started } from ${JSON.stringify(traceModuleUrl)};
const job = JSON.parse(fs.readFileSync(process.env.KRN_TRACE_DURABILITY_JOB, 'utf8'));
function startTicks(pid) {
  const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/u);
  return fields[19];
}
const identity = { pid: process.pid, startTicks: startTicks(process.pid) };
fs.writeFileSync(process.env.KRN_TRACE_DURABILITY_CALL_READY, JSON.stringify(identity) + '\\n', { flag: 'wx', mode: 0o600 });
const calledAtNs = process.hrtime.bigint().toString();
let outcome;
try {
  outcome = { kind: 'resolved', accepted: await started(job, 'intent-durable', 'session-durable') };
} catch (error) {
  outcome = {
    kind: 'rejected',
    errorName: error instanceof Error ? error.name : typeof error,
    errorCode: typeof error?.code === 'string' ? error.code : null,
  };
}
fs.writeFileSync(process.env.KRN_TRACE_DURABILITY_RESULT, JSON.stringify({ ...identity, calledAtNs, returnedAtNs: process.hrtime.bigint().toString(), outcome }) + '\\n', { flag: 'wx', mode: 0o600 });
`,
  );

  type ChildOutcome =
    | {
        kind: 'resolved';
        accepted: boolean;
      }
    | {
        kind: 'rejected';
        errorName: string;
        errorCode: string | null;
      };
  type ChildRecord = {
    pid: number;
    startTicks: string;
    calledAtNs: string;
    returnedAtNs: string;
    outcome: ChildOutcome;
  };
  type WorkerProcess = {
    readonly child: ReturnType<typeof spawn>;
    readonly closed: Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>;
    readonly stderr: () => string;
  };

  function processStartTicks(pid: number | undefined): string | undefined {
    if (!pid) return undefined;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/u)[19];
    } catch {
      return undefined;
    }
  }

  async function waitForJson(
    path: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as Record<
          string,
          unknown
        >;
      } catch (error) {
        if (
          error instanceof SyntaxError ||
          (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        ) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
          continue;
        }
        throw error;
      }
    }
    return undefined;
  }

  function launchWorker(
    role: string,
    tag: string,
  ): {
    readonly worker: WorkerProcess;
    readonly callReady: string;
    readonly result: string;
    readonly ready: string;
    readonly release: string;
    readonly fsyncSeen: string;
  } {
    const callReady = join(directory, `${tag}.call-ready.json`);
    const result = join(directory, `${tag}.result.json`);
    const ready = join(directory, `${tag}.fsync-ready.json`);
    const release = join(directory, `${tag}.fsync-release.json`);
    const fsyncSeen = join(directory, `${tag}.fsync-seen.json`);
    const child = spawn(
      process.execPath,
      ['--import', preloadFile, workerFile],
      {
        cwd: f.directory,
        env: {
          ...process.env,
          KRN_TRACE_DURABILITY_TRACE: f.tracePath,
          KRN_TRACE_DURABILITY_JOB: jobFile,
          KRN_TRACE_DURABILITY_ROLE: role,
          KRN_TRACE_DURABILITY_CALL_READY: callReady,
          KRN_TRACE_DURABILITY_RESULT: result,
          KRN_TRACE_DURABILITY_READY: ready,
          KRN_TRACE_DURABILITY_RELEASE: release,
          KRN_TRACE_DURABILITY_FSYNC_SEEN: fsyncSeen,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const closed = new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolvePromise) => {
      child.once('close', (code, signal) => resolvePromise({ code, signal }));
    });
    const worker = {
      child,
      closed,
      stderr: () => stderr,
    };
    return { worker, callReady, result, ready, release, fsyncSeen };
  }

  async function stopOwnedWorker(
    worker: WorkerProcess | undefined,
    identity: { readonly pid: number; readonly startTicks: string } | undefined,
  ): Promise<void> {
    if (!worker) return;
    const waitForClose = () =>
      Promise.race([
        worker.closed.then(() => true),
        new Promise<boolean>((resolvePromise) =>
          setTimeout(() => resolvePromise(false), 1500),
        ),
      ]);
    if (await waitForClose()) return;
    if (
      worker.child.exitCode === null &&
      worker.child.signalCode === null &&
      identity &&
      worker.child.pid === identity.pid &&
      processStartTicks(identity.pid) === identity.startTicks
    ) {
      worker.child.kill('SIGTERM');
    }
    if (
      !(await waitForClose()) &&
      worker.child.exitCode === null &&
      worker.child.signalCode === null &&
      identity &&
      worker.child.pid === identity.pid &&
      processStartTicks(identity.pid) === identity.startTicks
    )
      process.kill(identity.pid, 'SIGKILL');
    if (worker.child.exitCode === null && worker.child.signalCode === null)
      await worker.closed;
  }

  try {
    await t.test(
      'a same-session process waits for the owner fsync result',
      async () => {
        const owner = launchWorker('owner-pause', 'owner');
        let waiter: ReturnType<typeof launchWorker> | undefined;
        let ownerIdentity:
          | { readonly pid: number; readonly startTicks: string }
          | undefined;
        let waiterIdentity:
          | { readonly pid: number; readonly startTicks: string }
          | undefined;
        let waiterReturnedBeforeRelease = false;
        try {
          const ownerCallReady = await waitForJson(owner.callReady, 8000);
          assert.ok(
            ownerCallReady,
            `owner did not register: ${owner.worker.stderr()}`,
          );
          ownerIdentity = {
            pid: Number(ownerCallReady.pid),
            startTicks: String(ownerCallReady.startTicks),
          };
          assert.equal(ownerIdentity.pid, owner.worker.child.pid);
          assert.equal(
            processStartTicks(ownerIdentity.pid),
            ownerIdentity.startTicks,
          );

          const ownerReady = await waitForJson(owner.ready, 8000);
          assert.ok(
            ownerReady,
            `owner did not reach exact trace fsync: ${owner.worker.stderr()}`,
          );
          assert.equal(Number(ownerReady.pid), ownerIdentity.pid);
          assert.equal(String(ownerReady.startTicks), ownerIdentity.startTicks);
          assert.equal(ownerReady.tracePath, f.tracePath);
          assert.equal(
            ownerReady.traceBytes && Number(ownerReady.traceBytes) > 0,
            true,
          );
          assert.equal(ownerReady.rowKey, 'intent-durable:session');
          assert.equal(ownerReady.rowSessionId, 'session-durable');
          if (ownerReady.lock !== null) {
            const ownerLock = ownerReady.lock as Record<string, unknown>;
            assert.equal(Number(ownerLock.pid), ownerIdentity.pid);
            assert.equal(
              String(ownerLock.startTicks),
              ownerIdentity.startTicks,
            );
          }

          waiter = launchWorker('normal', 'waiter');
          const waiterReady = await waitForJson(waiter.callReady, 8000);
          assert.ok(
            waiterReady,
            `same-session caller did not register: ${waiter.worker.stderr()}`,
          );
          waiterIdentity = {
            pid: Number(waiterReady.pid),
            startTicks: String(waiterReady.startTicks),
          };
          assert.equal(waiterIdentity.pid, waiter.worker.child.pid);
          assert.equal(
            processStartTicks(waiterIdentity.pid),
            waiterIdentity.startTicks,
          );

          const beforeRelease = await waitForJson(waiter.result, 600);
          waiterReturnedBeforeRelease = beforeRelease !== undefined;
          process.stdout.write(
            `# trace.started live-owner observer ${JSON.stringify({ owner: ownerReady, waiter: waiterIdentity, waiterReturnedBeforeRelease: beforeRelease !== undefined })}\n`,
          );
        } finally {
          if (ownerIdentity && !existsSync(owner.release)) {
            writeFileSync(
              owner.release,
              `${JSON.stringify({
                ...ownerIdentity,
                releaseAtNs: process.hrtime.bigint().toString(),
              })}\n`,
              { flag: 'wx', mode: 0o600 },
            );
          }
          const waiterReady = waiter
            ? await waitForJson(waiter.callReady, 100)
            : undefined;
          waiterIdentity ??= waiterReady
            ? {
                pid: Number(waiterReady.pid),
                startTicks: String(waiterReady.startTicks),
              }
            : undefined;
          await Promise.all([
            stopOwnedWorker(owner.worker, ownerIdentity),
            stopOwnedWorker(waiter?.worker, waiterIdentity),
          ]);
        }

        const ownerRecord = (await waitForJson(owner.result, 1000)) as
          | ChildRecord
          | undefined;
        const waiterRecord = waiter
          ? ((await waitForJson(waiter.result, 1000)) as
              | ChildRecord
              | undefined)
          : undefined;
        assert.ok(
          ownerRecord,
          `owner result missing: ${owner.worker.stderr()}`,
        );
        assert.ok(
          waiterRecord,
          `same-session result missing: ${waiter?.worker.stderr()}`,
        );
        assert.deepEqual(await owner.worker.closed, { code: 0, signal: null });
        assert.deepEqual(await waiter?.worker.closed, {
          code: 0,
          signal: null,
        });
        assert.deepEqual(ownerRecord.outcome, {
          kind: 'rejected',
          errorName: 'Error',
          errorCode: 'EIO',
        });
        assert.deepEqual(waiterRecord.outcome, {
          kind: 'resolved',
          accepted: true,
        });
        const releaseRecord = JSON.parse(
          readFileSync(owner.release, 'utf8'),
        ) as {
          releaseAtNs: string;
        };
        assert.ok(
          BigInt(waiterRecord.returnedAtNs) >=
            BigInt(releaseRecord.releaseAtNs),
          'the accepted same-session call must return after the owner fsync attempt is released',
        );
        assert.notEqual(
          processStartTicks(ownerIdentity?.pid),
          ownerIdentity?.startTicks,
        );
        assert.notEqual(
          processStartTicks(waiterIdentity?.pid),
          waiterIdentity?.startTicks,
        );
        assert.equal(existsSync(`${f.tracePath}.lock`), false);
        assert.equal(
          waiterReturnedBeforeRelease,
          false,
          'same-session acceptance must wait until the trace fd fsync resolves',
        );
      },
    );

    await t.test(
      'a complete duplicate row must pass a locked fsync before acceptance',
      async () => {
        assert.equal(
          await trace.started(f.job, 'intent-durable', 'session-durable'),
          true,
        );
        const before = await readFile(f.tracePath);
        const duplicate = launchWorker('duplicate-fsync-eio', 'duplicate');
        let identity:
          | { readonly pid: number; readonly startTicks: string }
          | undefined;
        let duplicateContract:
          | {
              readonly interceptedExactTraceFsync: boolean;
              readonly outcome: unknown;
            }
          | undefined;
        try {
          const callReady = await waitForJson(duplicate.callReady, 8000);
          assert.ok(
            callReady,
            `duplicate caller did not register: ${duplicate.worker.stderr()}`,
          );
          identity = {
            pid: Number(callReady.pid),
            startTicks: String(callReady.startTicks),
          };
          assert.equal(identity.pid, duplicate.worker.child.pid);
          assert.equal(processStartTicks(identity.pid), identity.startTicks);
          const duplicateResult = await waitForJson(duplicate.result, 8000);
          assert.ok(
            duplicateResult,
            `duplicate caller did not return: ${duplicate.worker.stderr()}`,
          );
          const fsyncSeen = await waitForJson(duplicate.fsyncSeen, 1000);
          process.stdout.write(
            `# trace.started duplicate-fsync observer ${JSON.stringify({ pid: identity.pid, startTicks: identity.startTicks, interceptedExactTraceFsync: fsyncSeen !== undefined, result: duplicateResult })}\n`,
          );
          // Contract assertions run after cleanup and positive retry controls.
          duplicateContract = {
            interceptedExactTraceFsync: fsyncSeen !== undefined,
            outcome: duplicateResult.outcome,
          };
        } finally {
          await stopOwnedWorker(duplicate.worker, identity);
        }
        assert.deepEqual(await duplicate.worker.closed, {
          code: 0,
          signal: null,
        });
        assert.notEqual(processStartTicks(identity?.pid), identity?.startTicks);
        assert.equal(existsSync(`${f.tracePath}.lock`), false);
        assert.deepEqual(await readFile(f.tracePath), before);
        assert.equal(
          await trace.started(f.job, 'intent-durable', 'session-durable'),
          true,
          'a successful retry confirms durability and preserves normal duplicate acceptance',
        );
        assert.deepEqual(await readFile(f.tracePath), before);
        assert.deepEqual(
          duplicateContract,
          {
            interceptedExactTraceFsync: true,
            outcome: {
              kind: 'rejected',
              errorName: 'Error',
              errorCode: 'EIO',
            },
          },
          'a duplicate must not be accepted until its exact trace fd fsync succeeds',
        );
      },
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('trace appenders reclaim a real zombie owner and retain both rows', {
  timeout: 15_000,
}, async (t) => {
  const scratch = join(process.cwd(), '.krn/tmp');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'trace-zombie-owner-'));
  const job: Job = {
    id: `trace-zombie-${randomUUID()}`,
    issue: 'LON-291',
    worktree: directory,
    repoRoot: directory,
  };
  const initialized = spawnSync('git', ['-C', directory, 'init', '--quiet'], {
    encoding: 'utf8',
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const tracePath = join(stateDirectory(job), 'trace.jsonl');
  const parentScript = [
    'import os, signal, time',
    'pid = os.fork()',
    'if pid == 0: os._exit(0)',
    'def reap(_signum, _frame):',
    '    os.waitpid(pid, 0)',
    '    raise SystemExit(0)',
    'signal.signal(signal.SIGTERM, reap)',
    'print(pid, flush=True)',
    'while True: time.sleep(0.05)',
  ].join('\n');
  const zombieParent = spawn('python3', ['-c', parentScript], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let pidOutput = '';
  let parentStderr = '';
  zombieParent.stdout?.setEncoding('utf8').on('data', (chunk) => {
    pidOutput += chunk;
  });
  zombieParent.stderr?.setEncoding('utf8').on('data', (chunk) => {
    parentStderr += chunk;
  });
  const pidReady = new Promise<number>((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      const line = pidOutput.split('\n')[0];
      if (line) {
        resolve(Number(line));
        return;
      }
      if (zombieParent.exitCode !== null || Date.now() >= deadline) {
        reject(
          new Error(
            `zombie fixture parent did not publish PID: ${parentStderr}`,
          ),
        );
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
  let zombiePid: number | undefined;
  try {
    zombiePid = await pidReady;
    assert.ok(
      zombiePid !== undefined &&
        Number.isSafeInteger(zombiePid) &&
        zombiePid > 0,
    );
    const ownerPid = zombiePid;
    const statPath = `/proc/${ownerPid}/stat`;
    const readIdentity = () => {
      const raw = readFileSync(statPath, 'utf8');
      const fields = raw
        .slice(raw.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/u);
      return { state: fields[0], startTicks: fields[19] };
    };
    const deadline = Date.now() + 3000;
    let identity = readIdentity();
    while (identity.state !== 'Z' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      identity = readIdentity();
    }
    assert.equal(identity.state, 'Z', 'fixture child must be a real zombie');
    assert.match(identity.startTicks ?? '', /^\d+$/u);
    assert.doesNotThrow(() => process.kill(ownerPid, 0));
    t.diagnostic(
      `zombie owner pid=${ownerPid} startTicks=${identity.startTicks} procState=${identity.state}`,
    );

    const traceDirectory = dirname(tracePath);
    await mkdir(traceDirectory, { recursive: true });
    const lockPath = `${tracePath}.lock`;
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: ownerPid,
        startTicks: identity.startTicks,
        token: randomUUID(),
      }),
    );
    const barrier = join(directory, 'zombie-appenders');
    await mkdir(barrier);
    const jobFile = join(barrier, 'job.json');
    const child = join(barrier, 'append.mjs');
    await writeFile(jobFile, JSON.stringify(job));
    const traceUrl = new URL('../../src/trace/index.ts', import.meta.url).href;
    await writeFile(
      child,
      `
import { readFileSync } from 'node:fs';
import { verdict } from ${JSON.stringify(traceUrl)};
const job = JSON.parse(readFileSync(process.env.KRN_ZOMBIE_JOB, 'utf8'));
const sha = process.env.KRN_ZOMBIE_SHA;
await verdict(job, { sha, checks: [{ id: 'gate', exitCode: 0, durationMs: 1, sha256: sha.padEnd(64, '0').slice(0, 64) }] });
`,
    );
    const run = (sha: string) =>
      spawn(process.execPath, [child], {
        cwd: directory,
        env: {
          ...process.env,
          KRN_ZOMBIE_JOB: jobFile,
          KRN_ZOMBIE_SHA: sha,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    const first = run('a'.repeat(40));
    const second = run('b'.repeat(40));
    const collect = (process: ReturnType<typeof spawn>) =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        let stderr = '';
        process.stderr?.setEncoding('utf8').on('data', (chunk) => {
          stderr += chunk;
        });
        process.once('close', (code) => resolve({ code, stderr }));
      });
    try {
      const [firstResult, secondResult] = await Promise.all([
        collect(first),
        collect(second),
      ]);
      assert.equal(firstResult.code, 0, firstResult.stderr);
      assert.equal(secondResult.code, 0, secondResult.stderr);
      const rows = (await readFile(tracePath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { data: { sha?: string } });
      assert.deepEqual(
        rows.map((row) => row.data.sha).sort(),
        ['a'.repeat(40), 'b'.repeat(40)],
        'both independent appends must remain durable',
      );
      await assert.rejects(readFile(lockPath), { code: 'ENOENT' });
      await assert.rejects(readFile(`${lockPath}.reclaim`), { code: 'ENOENT' });
    } finally {
      for (const process of [first, second]) {
        if (process.exitCode === null && process.signalCode === null)
          process.kill('SIGKILL');
      }
    }
  } finally {
    if (zombieParent.exitCode === null && zombieParent.signalCode === null) {
      const closed = new Promise<void>((resolve) =>
        zombieParent.once('close', () => resolve()),
      );
      zombieParent.kill('SIGTERM');
      await closed;
    }
    if (zombiePid !== undefined)
      assert.throws(() => readFileSync(`/proc/${zombiePid}/stat`), {
        code: 'ENOENT',
      });
    await rm(directory, { recursive: true, force: true });
  }
});

test('independent trace appenders preserve events across a torn-tail repair', {
  timeout: 15_000,
}, async () => {
  const f = await fixture();
  const firstSha = 'a'.repeat(40);
  const secondSha = 'b'.repeat(40);
  const barrier = join(f.directory, 'barrier');
  await mkdir(barrier);
  await verdict(f.job, event('c'.repeat(40), 0, 'd'.repeat(64)));
  await appendFile(f.tracePath, '{"key":"torn"');
  const lockPath = `${f.tracePath}.lock`;
  const deadPid = process.pid + 1_000_000_000;
  await writeFile(
    lockPath,
    JSON.stringify({
      pid: deadPid,
      startTicks: '1',
      token: randomUUID(),
    }),
  );

  const preload = join(barrier, 'preload.mjs');
  const child = join(barrier, 'child.mjs');
  await writeFile(
    preload,
    `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const role = process.env.KRN_TRACE_BARRIER_ROLE;
const root = process.env.KRN_TRACE_BARRIER_DIR;
const lockPath = process.env.KRN_TRACE_BARRIER_LOCK;
const reclaimerPath = process.env.KRN_TRACE_BARRIER_RECLAIMER;
const waitFor = (name, timeout = 8000) => {
  const until = Date.now() + timeout;
  while (!fs.existsSync(root + '/' + name)) {
    if (Date.now() >= until) throw new Error('barrier timeout: ' + name);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
};
if (role === 'first') {
  const unlink = fs.unlinkSync;
  fs.unlinkSync = function (path, ...args) {
    if (String(path) === lockPath && fs.existsSync(reclaimerPath)) {
      fs.writeFileSync(root + '/stale-reclaim-held', '1');
      waitFor('release-stale-reclaim');
    }
    return unlink.call(this, path, ...args);
  };
  const original = fs.ftruncateSync;
  fs.ftruncateSync = function (...args) {
    fs.writeFileSync(root + '/first-repair', '1');
    waitFor('release-first');
    return original.apply(this, args);
  };
  const write = fs.writeSync;
  fs.writeSync = function (...args) {
    const value = Buffer.isBuffer(args[1]) ? args[1].toString() : String(args[1]);
    const result = write.apply(this, args);
    if (value.includes(process.env.KRN_TRACE_BARRIER_SHA)) {
      fs.writeFileSync(root + '/first-row', '1');
      waitFor('release-first-row');
    }
    return result;
  };
} else {
  const exists = fs.existsSync;
  fs.existsSync = function (path, ...args) {
    const found = exists.call(this, path, ...args);
    if (String(path) === reclaimerPath && found)
      fs.writeFileSync(root + '/second-saw-reclaimer', '1');
    return found;
  };
  const read = fs.readFileSync;
  fs.readFileSync = function (path, ...args) {
    const value = read.call(this, path, ...args);
    if (typeof path === 'number') {
      try {
        if (fs.readlinkSync('/proc/self/fd/' + path) === lockPath)
          fs.writeFileSync(root + '/second-saw-live-owner', '1');
      } catch {}
    }
    return value;
  };
  const original = fs.ftruncateSync;
  fs.ftruncateSync = function (...args) {
    fs.writeFileSync(root + '/second-repair', '1');
    waitFor('first-row');
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();
`,
  );
  await writeFile(
    child,
    `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const root = process.env.KRN_TRACE_BARRIER_DIR;
const { verdict } = await import(${JSON.stringify(new URL('../../src/trace/index.ts', import.meta.url).href)});
const job = JSON.parse(readFileSync(process.env.KRN_TRACE_BARRIER_JOB, 'utf8'));
const sha = process.env.KRN_TRACE_BARRIER_SHA;
if (process.env.KRN_TRACE_BARRIER_ROLE === 'second') {
  writeFileSync(root + '/second-ready', '1');
  const until = Date.now() + 8000;
  while (!existsSync(root + '/start-second')) {
    if (Date.now() >= until) throw new Error('barrier timeout: start-second');
  }
}
await verdict(job, { sha, checks: [{ id: 'gate', exitCode: 0, durationMs: 1, sha256: sha.padEnd(64, '0').slice(0, 64) }] });
`,
  );
  const jobFile = join(barrier, 'job.json');
  await writeFile(jobFile, JSON.stringify(f.job));

  const start = (role: 'first' | 'second', sha: string) =>
    spawn(process.execPath, ['--import', preload, child], {
      cwd: f.directory,
      env: {
        ...process.env,
        KRN_TRACE_BARRIER_ROLE: role,
        KRN_TRACE_BARRIER_DIR: barrier,
        KRN_TRACE_BARRIER_JOB: jobFile,
        KRN_TRACE_BARRIER_SHA: sha,
        KRN_TRACE_BARRIER_LOCK: lockPath,
        KRN_TRACE_BARRIER_RECLAIMER: `${lockPath}.reclaim`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const waitFor = async (name: string, timeout = 8000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      try {
        await readFile(join(barrier, name));
        return true;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  };
  const first = start('first', firstSha);
  let second: ReturnType<typeof spawn> | undefined;
  try {
    const staleReclaimerHeld = await waitFor('stale-reclaim-held', 500);
    if (!staleReclaimerHeld)
      assert.equal(
        await waitFor('first-repair'),
        true,
        'first process reached repair',
      );
    second = start('second', secondSha);
    assert.equal(
      await waitFor('second-ready'),
      true,
      'second process initialized',
    );
    await writeFile(join(barrier, 'start-second'), '1');
    if (staleReclaimerHeld) {
      await waitFor('second-saw-reclaimer');
      await writeFile(join(barrier, 'release-stale-reclaim'), '1');
      assert.equal(
        await waitFor('first-repair'),
        true,
        'first process reached repair',
      );
    }
    const secondReachedRepair = await waitFor('second-repair', 2000);
    // With serialization, the second writer cannot enter repair until the first
    // releases the owned lock. This bounded release keeps the observer live.
    await writeFile(join(barrier, 'release-first'), '1');
    if (secondReachedRepair)
      assert.equal(
        await waitFor('first-row'),
        true,
        'first row passed the barrier',
      );
    if (staleReclaimerHeld) await waitFor('second-saw-live-owner');
    await writeFile(join(barrier, 'release-first-row'), '1');
    const close = (proc: ReturnType<typeof spawn>) =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        let stderr = '';
        proc.stderr?.setEncoding('utf8').on('data', (chunk) => {
          stderr += chunk;
        });
        proc.once('close', (code) => resolve({ code, stderr }));
      });
    const [firstResult, secondResult] = await Promise.all([
      close(first),
      close(second),
    ]);
    assert.equal(firstResult.code, 0, firstResult.stderr);
    assert.equal(secondResult.code, 0, secondResult.stderr);
    const rows = (await readFile(f.tracePath, 'utf8'))
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row) as { data: { sha?: string } });
    assert.ok(
      rows.some((row) => row.data.sha === firstSha),
      'first append must survive',
    );
    assert.ok(
      rows.some((row) => row.data.sha === secondSha),
      'second append must survive',
    );
  } finally {
    for (const process of [first, second]) {
      if (process && process.exitCode === null && process.signalCode === null)
        process.kill('SIGKILL');
    }
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('trace appenders wait for primary lock owner publication before reading it', {
  timeout: 15000,
}, async () => {
  const f = await fixture();
  const barrier = join(f.directory, 'owner-publication');
  await mkdir(barrier);
  const lockPath = `${f.tracePath}.lock`;
  const ownerSha = '1'.repeat(40);
  const contenderSha = '2'.repeat(40);
  const jobFile = join(barrier, 'job.json');
  const preload = join(barrier, 'preload.mjs');
  const child = join(barrier, 'append.mjs');
  await writeFile(jobFile, JSON.stringify(f.job));
  await writeFile(
    preload,
    `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const root = process.env.KRN_TRACE_PUBLICATION_DIR;
const lockPath = process.env.KRN_TRACE_PUBLICATION_LOCK;
const waitFor = (name) => {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const until = Date.now() + 10000;
  while (!fs.existsSync(root + '/' + name)) {
    if (Date.now() >= until) throw new Error('publication barrier timeout: ' + name);
    Atomics.wait(cell, 0, 0, 10);
  }
};
if (process.env.KRN_TRACE_PUBLICATION_ROLE === 'owner') {
  const write = fs.writeSync;
  fs.writeSync = function (fd, ...args) {
    try {
      if (fs.readlinkSync('/proc/self/fd/' + fd) === lockPath) {
        fs.writeFileSync(root + '/owner-reserved', '1');
        waitFor('release-owner-write');
      }
    } catch (error) {
      if (error?.message?.startsWith('publication barrier timeout:')) throw error;
    }
    return write.call(this, fd, ...args);
  };
} else {
  const fstat = fs.fstatSync;
  fs.fstatSync = function (fd, ...args) {
    const stats = fstat.call(this, fd, ...args);
    try {
      if (stats.size === 0 && fs.readlinkSync('/proc/self/fd/' + fd) === lockPath)
        fs.writeFileSync(root + '/contender-saw-empty', '1');
    } catch {}
    return stats;
  };
}
syncBuiltinESMExports();
`,
  );
  await writeFile(
    child,
    `
import { readFileSync } from 'node:fs';
const { verdict } = await import(${JSON.stringify(new URL('../../src/trace/index.ts', import.meta.url).href)});
const job = JSON.parse(readFileSync(process.env.KRN_TRACE_PUBLICATION_JOB, 'utf8'));
const sha = process.env.KRN_TRACE_PUBLICATION_SHA;
await verdict(job, { sha, checks: [{ id: 'gate', exitCode: 0, durationMs: 1, sha256: sha.padEnd(64, '0').slice(0, 64) }] });
`,
  );

  const start = (role: 'owner' | 'contender', sha: string) =>
    spawn(process.execPath, ['--import', preload, child], {
      cwd: f.directory,
      env: {
        ...process.env,
        KRN_TRACE_PUBLICATION_ROLE: role,
        KRN_TRACE_PUBLICATION_DIR: barrier,
        KRN_TRACE_PUBLICATION_LOCK: lockPath,
        KRN_TRACE_PUBLICATION_JOB: jobFile,
        KRN_TRACE_PUBLICATION_SHA: sha,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const capture = (proc: ReturnType<typeof spawn>) =>
    new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
    }>((resolve) => {
      let stderr = '';
      proc.stderr?.setEncoding('utf8').on('data', (chunk) => {
        stderr += chunk;
      });
      proc.once('close', (code, signal) => resolve({ code, signal, stderr }));
    });
  const waitFor = async (name: string, timeout = 8000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      try {
        await readFile(join(barrier, name));
        return true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return false;
  };

  const owner = start('owner', ownerSha);
  const ownerResult = capture(owner);
  let contender: ReturnType<typeof spawn> | undefined;
  let contenderResult:
    | Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        stderr: string;
      }>
    | undefined;
  try {
    assert.equal(
      await waitFor('owner-reserved'),
      true,
      'first independent process created the lock before publishing owner bytes',
    );
    contender = start('contender', contenderSha);
    contenderResult = capture(contender);
    assert.equal(
      await waitFor('contender-saw-empty'),
      true,
      'second independent process read the empty primary owner file',
    );

    let exitedBeforePublication = false;
    const until = Date.now() + 300;
    while (Date.now() < until) {
      if (contender.exitCode !== null || contender.signalCode !== null) {
        exitedBeforePublication = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await writeFile(join(barrier, 'release-owner-write'), '1');
    const outcomes = await Promise.all([ownerResult, contenderResult]);
    const [ownerOutcome, contenderOutcome] = outcomes;
    assert.equal(
      exitedBeforePublication,
      false,
      'contender must wait for lock owner publication instead of rejecting an in-progress lock',
    );
    assert.equal(ownerOutcome.code, 0, ownerOutcome.stderr);
    assert.equal(contenderOutcome.code, 0, contenderOutcome.stderr);
    const rows = (await readFile(f.tracePath, 'utf8'))
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row) as { data: { sha?: string } });
    assert.ok(rows.some((row) => row.data.sha === ownerSha));
    assert.ok(
      rows.some((row) => row.data.sha === contenderSha),
      'second append must survive publication of the first lock owner',
    );
  } finally {
    await writeFile(join(barrier, 'release-owner-write'), '1').catch(() => {});
    for (const proc of [owner, contender]) {
      if (proc && proc.exitCode === null && proc.signalCode === null)
        proc.kill('SIGKILL');
    }
    await Promise.allSettled([
      ownerResult,
      ...(contenderResult ? [contenderResult] : []),
    ]);
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('trace records fail then pass at one SHA and deduplicates exact evidence', async () => {
  const f = await fixture();
  const sha = 'd'.repeat(40);
  const failed = event(sha, 1, 'e'.repeat(64));
  const passed = event(sha, 0, 'f'.repeat(64));
  try {
    await verdict(f.job, failed);
    const failOnlyCountsAsPassing = await hasVerdict(f.job, sha);
    await verdict(f.job, failed);
    await verdict(f.job, passed);

    const rows = (await readFile(f.tracePath, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            kind: string;
            data: { sha: string; checks: Array<{ exitCode: number }> };
          },
      );
    assert.equal(
      rows.length,
      2,
      'distinct verdict results must both be recorded',
    );
    assert.equal(rows.at(-1)?.data.sha, sha);
    assert.ok(rows.at(-1)?.data.checks.every((check) => check.exitCode === 0));
    assert.equal(failOnlyCountsAsPassing, false);
    assert.equal(await hasVerdict(f.job, sha), true);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('trace lock bounds live and invalid owners and reclaims a dead owner', async () => {
  const f = await fixture();
  const lockPath = `${f.tracePath}.lock`;
  const firstSha = 'a'.repeat(40);
  const base = event(firstSha, 0, 'b'.repeat(64));
  const selfStat = await readFile('/proc/self/stat', 'utf8');
  const beforeStartTicks = selfStat
    .slice(selfStat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/u)[19];
  assert.ok(beforeStartTicks);
  try {
    await verdict(f.job, base);
    const before = await readFile(f.tracePath);
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        startTicks: beforeStartTicks,
        token: randomUUID(),
      }),
    );
    const started = Date.now();
    await assert.rejects(
      verdict(f.job, event('c'.repeat(40), 0, 'd'.repeat(64))),
      /timed out/u,
    );
    assert.ok(Date.now() - started < 5000, 'live lock refusal must be bounded');
    assert.deepEqual(await readFile(f.tracePath), before);

    await unlink(lockPath);
    await writeFile(lockPath, '');
    const emptyStarted = Date.now();
    await assert.rejects(
      verdict(f.job, event('c'.repeat(40), 0, 'd'.repeat(64))),
      /timed out/u,
    );
    assert.ok(
      Date.now() - emptyStarted < 5000,
      'an orphan empty primary lock must fail closed within the acquisition bound',
    );
    assert.deepEqual(await readFile(f.tracePath), before);
    assert.deepEqual(await readFile(lockPath), Buffer.alloc(0));

    await unlink(lockPath);
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 0,
        startTicks: '1',
        token: randomUUID(),
      }),
    );
    await assert.rejects(
      verdict(f.job, event('e'.repeat(40), 0, 'f'.repeat(64))),
      /invalid trace lock owner/u,
    );
    assert.deepEqual(await readFile(f.tracePath), before);

    await unlink(lockPath);
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 1_000_000_000,
        startTicks: '1',
        token: randomUUID(),
      }),
    );
    const deadOwner = await readFile(lockPath);
    const reclaimerPath = `${lockPath}.reclaim`;
    await writeFile(reclaimerPath, '');
    const reclaimerStarted = Date.now();
    await assert.rejects(
      verdict(f.job, event('c'.repeat(40), 0, 'd'.repeat(64))),
      /timed out/u,
    );
    assert.ok(
      Date.now() - reclaimerStarted < 5000,
      'an orphan reclaimer gate must fail closed within the acquisition bound',
    );
    assert.deepEqual(await readFile(f.tracePath), before);
    assert.deepEqual(await readFile(lockPath), deadOwner);
    assert.deepEqual(await readFile(reclaimerPath), Buffer.alloc(0));
    await unlink(reclaimerPath);
    await verdict(f.job, event('c'.repeat(40), 0, 'd'.repeat(64)));
    assert.equal(await hasVerdict(f.job, 'c'.repeat(40)), true);
    await assert.rejects(readFile(lockPath), { code: 'ENOENT' });
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('trace lock refuses symlinks and non-file paths without touching targets', async () => {
  const f = await fixture();
  const lockPath = `${f.tracePath}.lock`;
  const target = join(f.directory, 'lock-target');
  const sha = 'a'.repeat(40);
  try {
    await verdict(f.job, event(sha, 0, 'b'.repeat(64)));
    const before = await readFile(f.tracePath);
    await writeFile(target, 'unchanged');
    await symlink(target, lockPath);
    await assert.rejects(
      verdict(f.job, event('c'.repeat(40), 0, 'd'.repeat(64))),
      /unsafe trace path/u,
    );
    assert.equal(await readFile(target, 'utf8'), 'unchanged');
    assert.deepEqual(await readFile(f.tracePath), before);

    await unlink(lockPath);
    await mkdir(lockPath);
    await assert.rejects(
      verdict(f.job, event('c'.repeat(40), 0, 'd'.repeat(64))),
      /unsafe trace lock/u,
    );
    assert.deepEqual(await readFile(f.tracePath), before);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('trace rejects FIFO paths immediately for append and read', {
  timeout: 5000,
}, async () => {
  const f = await fixture();
  try {
    await mkdir(dirname(f.tracePath), { recursive: true });
    const fifo = spawnSync('mkfifo', [f.tracePath], { encoding: 'utf8' });
    assert.equal(fifo.status, 0, fifo.stderr);

    const moduleUrl = new URL('../../src/trace/index.ts', import.meta.url).href;
    for (const operation of ['append', 'read'] as const) {
      const worker = new Worker(
        `
            import { parentPort, workerData } from 'node:worker_threads';
            const { hasVerdict, intent } = await import(workerData.moduleUrl);
            try {
              if (workerData.operation === 'append') await intent(workerData.job, 1);
              else await hasVerdict(workerData.job, '${'a'.repeat(40)}');
              parentPort.postMessage({ message: 'unexpected success' });
            } catch (error) {
              parentPort.postMessage({ message: error?.message });
            }
          `,
        {
          eval: true,
          workerData: { moduleUrl, operation, job: f.job },
        },
      );
      let timedOut = false;
      try {
        const result = await new Promise<{ message: string }>(
          (resolve, reject) => {
            const timer = setTimeout(() => {
              timedOut = true;
              reject(new Error(`${operation} hung while opening a FIFO`));
            }, 1000);
            worker.once('message', (value: { message: string }) => {
              clearTimeout(timer);
              resolve(value);
            });
            worker.once('error', (error) => {
              clearTimeout(timer);
              reject(error);
            });
          },
        );
        assert.deepEqual(result, { message: 'unsafe trace path' });
      } finally {
        if (timedOut) {
          worker.unref();
          void worker.terminate();
        } else {
          await worker.terminate();
        }
      }
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
