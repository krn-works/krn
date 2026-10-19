import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
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
import {
  processHasIdentity,
  processStartTicks,
} from '../../src/hosts/systemd-scope.ts';
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

test('job outcomes snapshot Error.message once before redaction', async () => {
  const f = await fixture();
  const canary = `sk-${'C'.repeat(24)}`;
  let getterReads = 0;
  const normalizationValue = {
    length: 0,
    includes: () => false,
    split: () => [],
    slice: () => canary,
    toString: () => '',
  };
  const normalizationResult = { trim: () => normalizationValue };
  const hostileNormalization = { replace: () => normalizationResult };
  const hostileError = new Error('initial message');
  Object.defineProperty(hostileError, 'message', {
    configurable: true,
    get() {
      getterReads += 1;
      return getterReads === 1
        ? 'ordinary snapshot message'
        : hostileNormalization;
    },
  });
  try {
    trace.jobOutcome(f.job, {
      exitCode: 1,
      signal: null,
      cleanup: 'verified',
      reason: 'runjob-error',
      error: hostileError,
    });
    trace.jobOutcome(f.job, {
      exitCode: 1,
      signal: null,
      cleanup: 'verified',
      reason: 'runjob-error',
      error: new Error('request failed with Bearer ordinary-secret-value'),
    });
    trace.jobOutcome(f.job, {
      exitCode: 1,
      signal: null,
      cleanup: 'verified',
      reason: 'runjob-error',
      error: new TypeError('ordinary public failure'),
    });

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
    assert.equal(outcomes.length, 3);
    assert.equal(
      JSON.stringify(outcomes).includes(canary),
      false,
      'a second message getter value must not bypass credential redaction',
    );
    assert.equal(getterReads, 1, 'Error.message must be read exactly once');
    assert.deepEqual(
      outcomes.map((row) => row.data.error?.message),
      ['ordinary snapshot message', '[redacted]', 'ordinary public failure'],
    );
    assert.deepEqual(
      outcomes.map((row) => row.data.error?.type),
      ['Error', 'Error', 'TypeError'],
    );
    assert.ok(!JSON.stringify(outcomes).includes('ordinary-secret-value'));
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
  const waitForFirstPhase = async () => {
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      if (existsSync(join(barrier, 'stale-reclaim-held')))
        return 'stale-reclaim-held' as const;
      if (existsSync(join(barrier, 'first-repair')))
        return 'first-repair' as const;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
  };
  const first = start('first', firstSha);
  let second: ReturnType<typeof spawn> | undefined;
  try {
    const firstPhase = await waitForFirstPhase();
    assert.notEqual(
      firstPhase,
      undefined,
      'first process reached startup phase',
    );
    const staleReclaimerHeld = firstPhase === 'stale-reclaim-held';
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

test('trace lock observer retries after the verified owner unlinks an opened lock', {
  timeout: 30000,
}, async () => {
  const f = await fixture();
  const barrier = join(f.directory, 'lock-disappearance');
  await mkdir(barrier);
  const lockPath = `${f.tracePath}.lock`;
  const ownerSha = '3'.repeat(40);
  const contenderSha = '4'.repeat(40);
  const jobFile = join(barrier, 'job.json');
  const preload = join(barrier, 'preload.cjs');
  const worker = join(barrier, 'append.mjs');
  const moduleUrl = new URL('../../src/trace/index.ts', import.meta.url).href;
  await writeFile(jobFile, JSON.stringify(f.job));
  await writeFile(
    preload,
    `
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const originals = {
  closeSync: fs.closeSync,
  fstatSync: fs.fstatSync,
  fsyncSync: fs.fsyncSync,
  openSync: fs.openSync,
  readFileSync: fs.readFileSync,
  readlinkSync: fs.readlinkSync,
  statSync: fs.statSync,
  writeFileSync: fs.writeFileSync,
};
const root = process.env.KRN_TRACE_UNLINK_ROOT;
const lockPath = process.env.KRN_TRACE_UNLINK_LOCK;
const tracePath = process.env.KRN_TRACE_UNLINK_TRACE;
const role = process.env.KRN_TRACE_UNLINK_ROLE;
function startTicks(pid = process.pid) {
  const stat = originals.readFileSync('/proc/' + pid + '/stat', 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/u)[19];
}
function writeMarker(name, value) {
  originals.writeFileSync(
    path.join(root, name),
    JSON.stringify(value) + '\\n',
    { flag: 'wx', mode: 0o600 },
  );
}
function waitForMarker(name) {
  const marker = path.join(root, name);
  const deadline = Date.now() + 12000;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    try {
      return JSON.parse(originals.readFileSync(marker, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    Atomics.wait(cell, 0, 0, 10);
  }
  throw new Error('lock unlink barrier timed out: ' + name);
}
let ownerPaused = false;
fs.fsyncSync = function (fd) {
  let actualPath;
  try {
    actualPath = originals.readlinkSync('/proc/' + process.pid + '/fd/' + fd);
  } catch {
    return originals.fsyncSync.call(this, fd);
  }
  if (role === 'owner' && actualPath === tracePath && !ownerPaused) {
    ownerPaused = true;
    const traceStats = originals.fstatSync(fd);
    const traceBytes = originals.readFileSync(tracePath, 'utf8');
    const lockStats = originals.statSync(lockPath);
    const lockOwner = JSON.parse(originals.readFileSync(lockPath, 'utf8'));
    const identity = { pid: process.pid, startTicks: startTicks() };
    writeMarker('owner-fsync-paused.json', {
      ...identity,
      fd,
      traceFdPath: actualPath,
      traceStats: { dev: traceStats.dev, ino: traceStats.ino, size: traceStats.size },
      ownerRowVisible: traceBytes.includes('"sha":"${ownerSha}"'),
      lockStats: { dev: lockStats.dev, ino: lockStats.ino, nlink: lockStats.nlink },
      lockOwner,
    });
    const release = waitForMarker('release-owner-fsync.json');
    if (release.pid !== identity.pid || release.startTicks !== identity.startTicks)
      throw new Error('owner release identity mismatch');
  }
  return originals.fsyncSync.call(this, fd);
};
let contenderPaused = false;
fs.openSync = function (pathArg, flags, ...rest) {
  const fd = originals.openSync.call(this, pathArg, flags, ...rest);
  if (
    role !== 'contender' ||
    path.resolve(String(pathArg)) !== path.resolve(lockPath) ||
    typeof flags !== 'number' ||
    (flags & fs.constants.O_ACCMODE) !== fs.constants.O_RDONLY ||
    contenderPaused
  )
    return fd;
  contenderPaused = true;
  const stats = originals.fstatSync(fd);
  const actualPath = originals.readlinkSync('/proc/' + process.pid + '/fd/' + fd);
  const identity = { pid: process.pid, startTicks: startTicks() };
  if (!stats.isFile() || stats.nlink !== 1 || actualPath !== lockPath) {
    originals.closeSync(fd);
    throw new Error('contender did not open the existing owned lock safely');
  }
  writeMarker('contender-lock-opened.json', {
    ...identity,
    fd,
    flags,
    accessMode: flags & fs.constants.O_ACCMODE,
    noFollow: (flags & (fs.constants.O_NOFOLLOW || 0)) !== 0,
    nonBlock: (flags & (fs.constants.O_NONBLOCK || 0)) !== 0,
    actualPath,
    stats: { dev: stats.dev, ino: stats.ino, nlink: stats.nlink, size: stats.size },
  });
  const release = waitForMarker('release-contender-open.json');
  if (release.pid !== identity.pid || release.startTicks !== identity.startTicks)
    throw new Error('contender release identity mismatch');
  const after = originals.fstatSync(fd);
  const afterPath = originals.readlinkSync('/proc/' + process.pid + '/fd/' + fd);
  writeMarker('contender-lock-after-unlink.json', {
    ...identity,
    fd,
    actualPath: afterPath,
    stats: { dev: after.dev, ino: after.ino, nlink: after.nlink, size: after.size },
  });
  return fd;
};
syncBuiltinESMExports();
`,
  );
  await writeFile(
    worker,
    `
import { readFileSync, writeFileSync } from 'node:fs';
const root = process.env.KRN_TRACE_UNLINK_ROOT;
const role = process.env.KRN_TRACE_UNLINK_ROLE;
const job = JSON.parse(readFileSync(process.env.KRN_TRACE_UNLINK_JOB, 'utf8'));
const identity = { pid: process.pid, startTicks: readFileSync('/proc/' + process.pid + '/stat', 'utf8').slice(readFileSync('/proc/' + process.pid + '/stat', 'utf8').lastIndexOf(')') + 2).trim().split(/\\s+/u)[19] };
writeFileSync(root + '/' + role + '-ready.json', JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
let outcome;
try {
  const { verdict } = await import(${JSON.stringify(moduleUrl)});
  const sha = role === 'owner' ? '${ownerSha}' : '${contenderSha}';
  await verdict(job, { sha, checks: [{ id: 'gate', exitCode: 0, durationMs: 1, sha256: sha.padEnd(64, '0') }] });
  outcome = { kind: 'resolved' };
} catch (error) {
  outcome = { kind: 'rejected', name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : 'non-Error rejection' };
}
writeFileSync(root + '/' + role + '-result.json', JSON.stringify({ ...identity, outcome }), { flag: 'wx', mode: 0o600 });
`,
  );

  type ChildRecord = {
    role: 'owner' | 'contender';
    child: ReturnType<typeof spawn>;
    identity?: { pid: number; startTicks: string };
    stdout: string;
    stderr: string;
    spawned: Promise<void>;
    closed: Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    }>;
  };
  const children: ChildRecord[] = [];
  const start = (role: ChildRecord['role']): ChildRecord => {
    const child = spawn(process.execPath, ['--require', preload, worker], {
      cwd: f.directory,
      env: {
        ...process.env,
        KRN_TRACE_UNLINK_ROOT: barrier,
        KRN_TRACE_UNLINK_LOCK: lockPath,
        KRN_TRACE_UNLINK_TRACE: f.tracePath,
        KRN_TRACE_UNLINK_ROLE: role,
        KRN_TRACE_UNLINK_JOB: jobFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const record: ChildRecord = {
      role,
      child,
      stdout: '',
      stderr: '',
      spawned: Promise.resolve(),
      closed: Promise.resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
      }),
    };
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      record.stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      record.stderr += chunk;
    });
    record.spawned = new Promise((resolve) => {
      child.once('spawn', () => {
        if (child.pid) {
          const startTicks = processStartTicks(child.pid);
          if (startTicks) record.identity = { pid: child.pid, startTicks };
        }
        resolve();
      });
      child.once('error', () => resolve());
    });
    record.closed = new Promise((resolve) => {
      child.once('close', (code, signal) =>
        resolve({ code, signal, stdout: record.stdout, stderr: record.stderr }),
      );
    });
    children.push(record);
    return record;
  };
  const waitFor = async (name: string, timeoutMs = 10000) => {
    const path = join(barrier, name);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as Record<
          string,
          unknown
        >;
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
          !(error instanceof SyntaxError)
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return undefined;
  };
  const release = async (name: string, child: ChildRecord | undefined) => {
    try {
      await writeFile(
        join(barrier, name),
        JSON.stringify(child?.identity ?? { pid: 0, startTicks: '0' }),
        { flag: 'wx', mode: 0o600 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  };
  const waitForClose = async (record: ChildRecord, timeoutMs: number) => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const result = await Promise.race([
      record.closed.then(() => true),
      timeout,
    ]);
    if (timer) clearTimeout(timer);
    return result;
  };

  let owner: ChildRecord | undefined;
  let contender: ChildRecord | undefined;
  try {
    owner = start('owner');
    await owner.spawned;
    assert.ok(
      owner.identity,
      `owner spawn identity unavailable; stderr=${owner.stderr}`,
    );
    const ownerReady = await waitFor('owner-ready.json');
    assert.deepEqual(
      ownerReady,
      owner.identity,
      'owner fixture process identity changed',
    );
    const paused = await waitFor('owner-fsync-paused.json');
    assert.ok(paused, 'owner did not pause before the real trace fsync');
    assert.equal(paused.pid, owner.identity.pid);
    assert.equal(paused.startTicks, owner.identity.startTicks);
    assert.equal(paused.traceFdPath, f.tracePath);
    assert.equal(paused.ownerRowVisible, true);
    const pausedLockStats = paused.lockStats as {
      dev: number;
      ino: number;
      nlink: number;
    };
    assert.equal(pausedLockStats.nlink, 1);

    contender = start('contender');
    await contender.spawned;
    assert.ok(
      contender.identity,
      `contender spawn identity unavailable; stderr=${contender.stderr}`,
    );
    const contenderReady = await waitFor('contender-ready.json');
    assert.deepEqual(
      contenderReady,
      contender.identity,
      'contender fixture process identity changed',
    );
    const opened = await waitFor('contender-lock-opened.json');
    assert.ok(opened, 'contender did not open the existing primary lock');
    assert.equal(opened.pid, contender.identity.pid);
    assert.equal(opened.startTicks, contender.identity.startTicks);
    assert.equal(opened.accessMode, 0);
    assert.equal(opened.noFollow, true);
    assert.equal(opened.nonBlock, true);
    assert.equal(opened.actualPath, lockPath);
    const openedStats = opened.stats as {
      dev: number;
      ino: number;
      nlink: number;
    };
    assert.equal(openedStats.dev, pausedLockStats.dev);
    assert.equal(openedStats.ino, pausedLockStats.ino);
    assert.equal(openedStats.nlink, 1);

    await release('release-owner-fsync.json', owner);
    const ownerClosed = await owner.closed;
    const fdPath = `/proc/${contender.identity.pid}/fd/${String(opened.fd)}`;
    const deletedPath = readlinkSync(fdPath);
    const deletedStats = statSync(fdPath);
    assert.equal(ownerClosed.code, 0, `owner stderr=${ownerClosed.stderr}`);
    assert.equal(ownerClosed.signal, null);
    assert.equal(
      existsSync(lockPath),
      false,
      'owner did not remove its exact primary lock',
    );
    assert.equal(deletedPath, `${lockPath} (deleted)`);
    assert.equal(deletedStats.dev, openedStats.dev);
    assert.equal(deletedStats.ino, openedStats.ino);
    assert.equal(deletedStats.nlink, 0);

    await release('release-contender-open.json', contender);
    const contenderClosed = await contender.closed;
    const resumed = await waitFor('contender-lock-after-unlink.json');
    assert.ok(
      resumed,
      'contender did not record its open fd after owner unlink',
    );
    assert.equal(resumed.pid, contender.identity.pid);
    assert.equal(resumed.startTicks, contender.identity.startTicks);
    assert.equal(resumed.fd, opened.fd);
    assert.equal(resumed.actualPath, deletedPath);
    const resumedStats = resumed.stats as {
      dev: number;
      ino: number;
      nlink: number;
    };
    assert.equal(resumedStats.dev, openedStats.dev);
    assert.equal(resumedStats.ino, openedStats.ino);
    assert.equal(resumedStats.nlink, 0);
    assert.equal(
      contenderClosed.code,
      0,
      `contender stderr=${contenderClosed.stderr}`,
    );
    assert.equal(contenderClosed.signal, null);

    const ownerResult = JSON.parse(
      await readFile(join(barrier, 'owner-result.json'), 'utf8'),
    ) as { outcome: { kind: string }; pid: number; startTicks: string };
    const contenderResult = JSON.parse(
      await readFile(join(barrier, 'contender-result.json'), 'utf8'),
    ) as {
      outcome: { kind: string; message?: string };
      pid: number;
      startTicks: string;
    };
    const rows = (await readFile(f.tracePath, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) => JSON.parse(line) as { kind: string; data: { sha?: string } },
      );
    const ownerGone = !processHasIdentity(
      owner.identity.pid,
      owner.identity.startTicks,
    );
    const contenderGone = !processHasIdentity(
      contender.identity.pid,
      contender.identity.startTicks,
    );
    const evidence = {
      owner: {
        identity: owner.identity,
        close: ownerClosed,
        result: ownerResult,
        fsyncPaused: paused,
        identityGoneAfterClose: ownerGone,
      },
      contender: {
        identity: contender.identity,
        close: contenderClosed,
        result: contenderResult,
        lockOpened: opened,
        fdAfterOwnerUnlink: {
          path: deletedPath,
          dev: deletedStats.dev,
          ino: deletedStats.ino,
          nlink: deletedStats.nlink,
        },
        resumed,
        identityGoneAfterClose: contenderGone,
      },
      rows,
      lockAbsent: !existsSync(lockPath),
      reclaimerAbsent: !existsSync(`${lockPath}.reclaim`),
    };
    const evidencePath = process.env.KRN_TRACE_UNLINK_EVIDENCE;
    if (evidencePath)
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });

    assert.deepEqual(
      ownerResult.outcome,
      { kind: 'resolved' },
      `owner result=${JSON.stringify(ownerResult)} stderr=${ownerClosed.stderr}`,
    );
    assert.deepEqual(
      contenderResult.outcome,
      { kind: 'resolved' },
      `contender result=${JSON.stringify(contenderResult)} stderr=${contenderClosed.stderr}`,
    );
    assert.equal(
      rows.length,
      2,
      `expected both intact rows, got ${JSON.stringify(rows)}`,
    );
    assert.deepEqual(
      rows.map((row) => row.data.sha).sort(),
      [ownerSha, contenderSha].sort(),
    );
    assert.ok(rows.every((row) => row.kind === 'verdict'));
    assert.equal(evidence.lockAbsent, true);
    assert.equal(evidence.reclaimerAbsent, true);
    assert.equal(
      ownerGone,
      true,
      `owner identity remained after close: ${JSON.stringify(owner.identity)}`,
    );
    assert.equal(
      contenderGone,
      true,
      `contender identity remained after close: ${JSON.stringify(contender.identity)}`,
    );
  } finally {
    await release('release-owner-fsync.json', owner);
    await release('release-contender-open.json', contender);
    await Promise.all(children.map((child) => child.spawned));
    for (const child of children) {
      if (await waitForClose(child, 1200)) continue;
      if (
        child.identity &&
        processHasIdentity(child.identity.pid, child.identity.startTicks)
      )
        child.child.kill('SIGTERM');
      if (await waitForClose(child, 1200)) continue;
      if (
        child.identity &&
        processHasIdentity(child.identity.pid, child.identity.startTicks)
      )
        child.child.kill('SIGKILL');
      await child.closed;
    }
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('trace lock observer retries only the two verified unlink timings', {
  timeout: 60_000,
}, async () => {
  type Variant =
    | 'unlink-after-open'
    | 'unlink-after-readlink'
    | 'hardlink-then-unlink'
    | 'symlink-replacement'
    | 'rename-to-nonsuffix';
  const variants: readonly Variant[] = [
    'unlink-after-open',
    'unlink-after-readlink',
    'hardlink-then-unlink',
    'symlink-replacement',
    'rename-to-nonsuffix',
  ];
  const table: unknown[] = [];
  const ownerIdentity = {
    pid: process.pid,
    startTicks: processStartTicks(process.pid),
  };
  assert.ok(ownerIdentity.startTicks, 'parent start ticks must be available');

  for (const [index, variant] of variants.entries()) {
    const f = await fixture();
    const barrier = join(f.directory, 'lock-observation-table');
    const lockPath = `${f.tracePath}.lock`;
    const asidePath = `${lockPath}.aside`;
    const movedPath = `${lockPath}.moved`;
    const targetPath = join(f.directory, 'symlink-target');
    const jobFile = join(barrier, 'job.json');
    const preloadPath = join(barrier, 'preload.cjs');
    const workerPath = join(barrier, 'verdict.mjs');
    const sha = String(index + 1).repeat(40);
    const owner = {
      ...ownerIdentity,
      token: randomUUID(),
    };
    await mkdir(barrier, { recursive: true });
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(jobFile, JSON.stringify(f.job));

    let targetBytes: Buffer | undefined;
    if (variant === 'symlink-replacement') {
      targetBytes = Buffer.from('unmodified symlink target');
      writeFileSync(targetPath, targetBytes, { flag: 'wx', mode: 0o600 });
    }

    const ownerBytes = Buffer.from(JSON.stringify(owner));
    let ownerFd: number | undefined;
    let ownerStats: ReturnType<typeof fstatSync> | undefined;

    await writeFile(
      preloadPath,
      `
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const originals = {
  fstatSync: fs.fstatSync,
  openSync: fs.openSync,
  readFileSync: fs.readFileSync,
  readlinkSync: fs.readlinkSync,
  writeFileSync: fs.writeFileSync,
};
const root = process.env.KRN_TRACE_LOCK_TABLE_ROOT;
const lockPath = process.env.KRN_TRACE_LOCK_TABLE_LOCK;
const variant = process.env.KRN_TRACE_LOCK_TABLE_VARIANT;
const identity = {
  pid: process.pid,
  startTicks: originals.readFileSync('/proc/' + process.pid + '/stat', 'utf8')
    .slice(originals.readFileSync('/proc/' + process.pid + '/stat', 'utf8').lastIndexOf(')') + 2)
    .trim().split(/\\s+/u)[19],
};
function marker(name, value) {
  originals.writeFileSync(
    path.join(root, name),
    JSON.stringify(value) + '\\n',
    { flag: 'wx', mode: 0o600 },
  );
}
function waitFor(name) {
  const markerPath = path.join(root, name);
  const deadline = Date.now() + 10000;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    try {
      return JSON.parse(originals.readFileSync(markerPath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    Atomics.wait(cell, 0, 0, 10);
  }
  throw new Error('lock table barrier timed out: ' + name);
}
let lockFd;
let readlinkPaused = false;
fs.openSync = function (pathArg, flags, ...rest) {
  const fd = originals.openSync.call(this, pathArg, flags, ...rest);
  if (
    path.resolve(String(pathArg)) !== path.resolve(lockPath) ||
    typeof flags !== 'number' ||
    (flags & fs.constants.O_ACCMODE) !== fs.constants.O_RDONLY ||
    lockFd !== undefined
  ) return fd;
  lockFd = fd;
  const stats = originals.fstatSync(fd);
  const actualPath = originals.readlinkSync('/proc/' + process.pid + '/fd/' + fd);
  marker('lock-opened.json', {
    ...identity,
    fd,
    flags,
    accessMode: flags & fs.constants.O_ACCMODE,
    noFollow: (flags & (fs.constants.O_NOFOLLOW || 0)) !== 0,
    nonBlock: (flags & (fs.constants.O_NONBLOCK || 0)) !== 0,
    actualPath,
    stats: { dev: stats.dev, ino: stats.ino, nlink: stats.nlink, size: stats.size },
    owner: JSON.parse(originals.readFileSync(lockPath, 'utf8')),
  });
  if (variant !== 'unlink-after-readlink') {
    const release = waitFor('release-open.json');
    if (release.pid !== identity.pid || release.startTicks !== identity.startTicks)
      throw new Error('open release identity mismatch');
  }
  return fd;
};
fs.readlinkSync = function (pathArg, ...rest) {
  const actualPath = originals.readlinkSync.call(this, pathArg, ...rest);
  if (
    variant === 'unlink-after-readlink' &&
    !readlinkPaused &&
    lockFd !== undefined &&
    String(pathArg) === '/proc/self/fd/' + lockFd &&
    actualPath === lockPath
  ) {
    readlinkPaused = true;
    const stats = originals.fstatSync(lockFd);
    marker('lock-readlink-returned.json', {
      ...identity,
      fd: lockFd,
      actualPath,
      stats: { dev: stats.dev, ino: stats.ino, nlink: stats.nlink, size: stats.size },
    });
    const release = waitFor('release-readlink.json');
    if (release.pid !== identity.pid || release.startTicks !== identity.startTicks)
      throw new Error('readlink release identity mismatch');
  }
  return actualPath;
};
syncBuiltinESMExports();
`,
    );
    await writeFile(
      workerPath,
      `
import { readFileSync, writeFileSync } from 'node:fs';
const root = process.env.KRN_TRACE_LOCK_TABLE_ROOT;
const job = JSON.parse(readFileSync(process.env.KRN_TRACE_LOCK_TABLE_JOB, 'utf8'));
const sha = process.env.KRN_TRACE_LOCK_TABLE_SHA;
const identity = {
  pid: process.pid,
  startTicks: readFileSync('/proc/' + process.pid + '/stat', 'utf8')
    .slice(readFileSync('/proc/' + process.pid + '/stat', 'utf8').lastIndexOf(')') + 2)
    .trim().split(/\\s+/u)[19],
};
writeFileSync(root + '/ready.json', JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
let outcome;
try {
  const { verdict } = await import(${JSON.stringify(new URL('../../src/trace/index.ts', import.meta.url).href)});
  await verdict(job, { sha, checks: [{ id: 'gate', exitCode: 0, durationMs: 1, sha256: sha.padEnd(64, '0') }] });
  outcome = { kind: 'resolved' };
} catch (error) {
  outcome = {
    kind: 'rejected',
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : 'non-Error rejection',
  };
}
writeFileSync(root + '/result.json', JSON.stringify({ ...identity, outcome }), { flag: 'wx', mode: 0o600 });
`,
    );

    let stdout = '';
    let stderr = '';
    let child: ReturnType<typeof spawn> | undefined;
    let childIdentity: { pid: number; startTicks: string } | undefined;
    let childClosed:
      | Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
          stdout: string;
          stderr: string;
        }>
      | undefined;
    const waitFor = async (name: string, timeoutMs = 10_000) => {
      const markerPath = join(barrier, name);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          return JSON.parse(await readFile(markerPath, 'utf8')) as Record<
            string,
            unknown
          >;
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
            !(error instanceof SyntaxError)
          )
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      return undefined;
    };
    const settleWithin = async <T>(promise: Promise<T>, timeoutMs: number) => {
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        promise,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      return outcome;
    };
    const writeReleaseMarker = async (
      name: string,
      identity: { pid: number; startTicks: string },
    ) => {
      try {
        await writeFile(join(barrier, name), JSON.stringify(identity), {
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    };
    const release = async (name: string) => {
      assert.ok(
        childIdentity,
        'child identity is required for barrier release',
      );
      await writeReleaseMarker(name, childIdentity);
    };

    try {
      ownerFd = openSync(
        lockPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      assert.equal(writeSync(ownerFd, ownerBytes), ownerBytes.length);
      fsyncSync(ownerFd);
      ownerStats = fstatSync(ownerFd);
      assert.equal(ownerStats.isFile(), true);
      assert.equal(ownerStats.nlink, 1);

      child = spawn(process.execPath, ['--require', preloadPath, workerPath], {
        cwd: f.directory,
        env: {
          ...process.env,
          KRN_TRACE_LOCK_TABLE_ROOT: barrier,
          KRN_TRACE_LOCK_TABLE_LOCK: lockPath,
          KRN_TRACE_LOCK_TABLE_VARIANT: variant,
          KRN_TRACE_LOCK_TABLE_JOB: jobFile,
          KRN_TRACE_LOCK_TABLE_SHA: sha,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      const spawned = new Promise<void>((resolve, reject) => {
        child?.once('spawn', resolve);
        child?.once('error', reject);
      });
      childClosed = new Promise((resolve) => {
        child?.once('close', (code, signal) =>
          resolve({ code, signal, stdout, stderr }),
        );
      });
      await spawned;
      assert.ok(child.pid, 'child PID is required');
      const childTicks = processStartTicks(child.pid);
      assert.ok(childTicks, 'child start ticks are required');
      childIdentity = { pid: child.pid, startTicks: childTicks };

      const ready = await waitFor('ready.json');
      assert.deepEqual(ready, childIdentity);
      const opened = await waitFor('lock-opened.json');
      if (!opened) {
        const result = await waitFor('result.json', 100);
        assert.fail(
          `${variant}: child did not open the actual primary lock; result=${JSON.stringify(result)} stdout=${stdout} stderr=${stderr}`,
        );
      }
      assert.equal(opened.pid, childIdentity.pid);
      assert.equal(opened.startTicks, childIdentity.startTicks);
      assert.equal(opened.accessMode, constants.O_RDONLY);
      assert.equal(opened.noFollow, true);
      assert.equal(opened.nonBlock, true);
      assert.equal(opened.actualPath, lockPath);
      const openedFd = opened.fd as number;
      const openedStats = opened.stats as {
        dev: number;
        ino: number;
        nlink: number;
        size: number;
      };
      assert.equal(openedStats.dev, ownerStats.dev);
      assert.equal(openedStats.ino, ownerStats.ino);
      assert.equal(openedStats.nlink, 1);
      assert.deepEqual(opened.owner, owner);

      let readlinkObservation: Record<string, unknown> | undefined;
      if (variant === 'unlink-after-readlink') {
        readlinkObservation = await waitFor('lock-readlink-returned.json');
        if (!readlinkObservation) {
          const result = await waitFor('result.json', 100);
          assert.fail(
            `real readlink did not return before unlink; result=${JSON.stringify(result)} stdout=${stdout} stderr=${stderr}`,
          );
        }
        assert.equal(readlinkObservation.pid, childIdentity.pid);
        assert.equal(readlinkObservation.fd, openedFd);
        assert.equal(readlinkObservation.actualPath, lockPath);
        const beforeUnlink = readlinkObservation.stats as { nlink: number };
        assert.equal(beforeUnlink.nlink, 1);
      }

      if (variant === 'hardlink-then-unlink') {
        linkSync(lockPath, asidePath);
        unlinkSync(lockPath);
      } else if (variant === 'symlink-replacement') {
        unlinkSync(lockPath);
        symlinkSync(targetPath, lockPath);
      } else if (variant === 'rename-to-nonsuffix') {
        renameSync(lockPath, movedPath);
      } else {
        unlinkSync(lockPath);
      }

      const childFdPath = `/proc/${childIdentity.pid}/fd/${openedFd}`;
      const fdPathAfterMutation = readlinkSync(childFdPath);
      const fdStatsAfterMutation = statSync(childFdPath);
      const pathAfterMutation = {
        path: fdPathAfterMutation,
        dev: fdStatsAfterMutation.dev,
        ino: fdStatsAfterMutation.ino,
        nlink: fdStatsAfterMutation.nlink,
      };
      assert.equal(pathAfterMutation.dev, ownerStats.dev);
      assert.equal(pathAfterMutation.ino, ownerStats.ino);
      if (variant === 'rename-to-nonsuffix') {
        assert.equal(fdPathAfterMutation, movedPath);
        assert.equal(fdStatsAfterMutation.nlink, 1);
      } else {
        assert.equal(fdPathAfterMutation, `${lockPath} (deleted)`);
        assert.equal(
          fdStatsAfterMutation.nlink,
          variant === 'hardlink-then-unlink' ? 1 : 0,
        );
      }
      assert.equal(
        processHasIdentity(ownerIdentity.pid, ownerIdentity.startTicks),
        true,
        'the real parent owner must remain live during the observation',
      );
      assert.ok(ownerFd !== undefined);
      assert.equal(fstatSync(ownerFd).dev, ownerStats.dev);
      assert.equal(fstatSync(ownerFd).ino, ownerStats.ino);

      const releaseName =
        variant === 'unlink-after-readlink'
          ? 'release-readlink.json'
          : 'release-open.json';
      await release(releaseName);
      const result = await waitFor('result.json', 12_000);
      assert.ok(result, `${variant}: child did not report a verdict result`);
      assert.equal(result.pid, childIdentity.pid);
      assert.equal(result.startTicks, childIdentity.startTicks);
      assert.ok(childClosed);
      const closed = await settleWithin(childClosed, 5000);
      assert.ok(closed, `${variant}: child did not close after reporting`);
      assert.equal(closed.code, 0, `${variant}: stderr=${closed.stderr}`);
      assert.equal(closed.signal, null);
      assert.equal(closed.stderr, '');
      assert.equal(
        processHasIdentity(childIdentity.pid, childIdentity.startTicks),
        false,
        `${variant}: child identity remained after close`,
      );

      const outcome = result.outcome as {
        kind: string;
        message?: string;
        name?: string;
      };
      const traceExists = existsSync(f.tracePath);
      const traceBytes = traceExists
        ? readFileSync(f.tracePath)
        : Buffer.alloc(0);
      const asideBytes = existsSync(asidePath)
        ? readFileSync(asidePath)
        : undefined;
      const movedBytes = existsSync(movedPath)
        ? readFileSync(movedPath)
        : undefined;
      const targetAfter = existsSync(targetPath)
        ? readFileSync(targetPath)
        : undefined;
      const record = {
        variant,
        owner: {
          identity: ownerIdentity,
          fd: ownerFd,
          initialLock: {
            dev: ownerStats.dev,
            ino: ownerStats.ino,
            nlink: ownerStats.nlink,
            bytes: ownerBytes.toString('utf8'),
          },
          stillLiveDuringObservation: true,
        },
        child: {
          identity: childIdentity,
          fd: openedFd,
          flags: opened.flags,
          initialPath: opened.actualPath,
          initialStats: openedStats,
          readlinkObservation,
          pathAfterMutation,
          result,
          close: closed,
          identityGoneAfterClose: true,
        },
        traceExists,
        traceBytes: traceBytes.toString('utf8'),
        asideExists: existsSync(asidePath),
        asideBytes: asideBytes?.toString('utf8'),
        movedExists: existsSync(movedPath),
        movedBytes: movedBytes?.toString('utf8'),
        symlinkTarget: existsSync(lockPath)
          ? readlinkSync(lockPath)
          : undefined,
        targetBytes: targetAfter?.toString('utf8'),
        reclaimerExists: existsSync(`${lockPath}.reclaim`),
      };
      table.push(record);

      if (
        variant === 'unlink-after-open' ||
        variant === 'unlink-after-readlink'
      ) {
        assert.deepEqual(outcome, { kind: 'resolved' });
        assert.equal(traceExists, true);
        const rows = traceBytes
          .toString('utf8')
          .trim()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as { kind: string; data: { sha: string } },
          );
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.kind, 'verdict');
        assert.equal(rows[0]?.data.sha, sha);
        assert.equal(existsSync(lockPath), false);
      } else {
        assert.equal(
          outcome.kind,
          'rejected',
          `${variant} must refuse the changed path`,
        );
        assert.match(outcome.message ?? '', /unsafe trace (?:path|lock)/u);
        assert.equal(
          traceExists,
          false,
          `${variant}: refusal must not create or append trace bytes`,
        );
        if (variant === 'hardlink-then-unlink') {
          assert.equal(existsSync(asidePath), true);
          assert.deepEqual(asideBytes, ownerBytes);
          assert.equal(statSync(asidePath).nlink, 1);
          assert.equal(existsSync(lockPath), false);
        } else if (variant === 'symlink-replacement') {
          assert.equal(readlinkSync(lockPath), targetPath);
          assert.deepEqual(targetAfter, targetBytes);
          assert.equal(existsSync(targetPath), true);
        } else {
          assert.equal(existsSync(lockPath), false);
          assert.equal(existsSync(movedPath), true);
          assert.deepEqual(movedBytes, ownerBytes);
        }
      }
      assert.equal(existsSync(`${lockPath}.reclaim`), false);
    } finally {
      if (childIdentity) {
        const identity = childIdentity;
        await Promise.all(
          ['release-open.json', 'release-readlink.json'].map((name) =>
            writeReleaseMarker(name, identity),
          ),
        );
      }
      if (child && childClosed) {
        const closed = await settleWithin(childClosed, 1500);
        if (
          closed === null &&
          childIdentity &&
          processHasIdentity(childIdentity.pid, childIdentity.startTicks)
        ) {
          child.kill('SIGTERM');
          const afterTerm = await settleWithin(childClosed, 1500);
          if (
            afterTerm === null &&
            processHasIdentity(childIdentity.pid, childIdentity.startTicks)
          )
            child.kill('SIGKILL');
          await childClosed;
        }
      }
      if (ownerFd !== undefined) closeSync(ownerFd);
      await rm(f.directory, { recursive: true, force: true });
    }
  }

  const evidencePath = process.env.KRN_TRACE_LOCK_TABLE_EVIDENCE;
  if (evidencePath)
    await writeFile(evidencePath, `${JSON.stringify(table, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  assert.equal(table.length, variants.length);
});

test('trace verdict retries when a stale reclaimer loses its primary-lock create race', {
  timeout: 45_000,
}, async () => {
  const f = await fixture();
  const barrier = join(f.directory, 'stale-reclaimer-race');
  const lockPath = `${f.tracePath}.lock`;
  const reclaimerPath = `${lockPath}.reclaim`;
  const preloadPath = join(barrier, 'preload.cjs');
  const workerPath = join(barrier, 'verdict.mjs');
  const jobPath = join(barrier, 'job.json');
  const traceUrl = new URL('../../src/trace/index.ts', import.meta.url).href;
  type RaceChild = {
    role: 'A' | 'B';
    child: ReturnType<typeof spawn>;
    stdout: string;
    stderr: string;
    closed: Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    }>;
    identity?: { pid: number; startTicks: string };
  };
  const children: RaceChild[] = [];
  let staleOwner: ReturnType<typeof spawn> | undefined;
  let staleOwnerClosed: Promise<NodeJS.Signals | null> | undefined;
  let staleIdentity: { pid: number; startTicks: string } | undefined;
  const waitFor = async (name: string, timeoutMs = 10_000) => {
    const markerPath = join(barrier, name);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        return JSON.parse(await readFile(markerPath, 'utf8')) as Record<
          string,
          unknown
        >;
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
          !(error instanceof SyntaxError)
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return undefined;
  };
  const marker = async (name: string) => {
    try {
      await writeFile(join(barrier, name), '{}\n', {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  };
  const start = async (role: 'A' | 'B') => {
    const child = spawn(
      process.execPath,
      ['--require', preloadPath, workerPath],
      {
        cwd: f.directory,
        env: {
          ...process.env,
          KRN_D1_ROLE: role,
          KRN_D1_ROOT: barrier,
          KRN_D1_LOCK: lockPath,
          KRN_D1_RECLAIMER: reclaimerPath,
          KRN_D1_JOB: jobPath,
          KRN_D1_TRACE_URL: traceUrl,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const item: RaceChild = {
      role,
      child,
      stdout: '',
      stderr: '',
      closed: Promise.resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
      }) as Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        stdout: string;
        stderr: string;
      }>,
    };
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      item.stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      item.stderr += chunk;
    });
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    item.closed = new Promise((resolve) => {
      child.once('close', (code, signal) =>
        resolve({
          code,
          signal,
          stdout: item.stdout,
          stderr: item.stderr,
        }),
      );
    });
    children.push(item);
    await spawned;
    assert.ok(child.pid, `${role} worker PID must exist`);
    const startTicks = processStartTicks(child.pid);
    assert.ok(startTicks, `${role} worker start ticks must exist`);
    item.identity = { pid: child.pid, startTicks };
    const boot = await waitFor(`${role}_BOOT.json`);
    assert.deepEqual(boot, { ...item.identity, role });
    return item;
  };

  try {
    await mkdir(barrier, { recursive: true });
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(jobPath, JSON.stringify(f.job), { mode: 0o600 });

    await writeFile(
      preloadPath,
      `
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const original = {
  existsSync: fs.existsSync.bind(fs),
  openSync: fs.openSync.bind(fs),
  fsyncSync: fs.fsyncSync.bind(fs),
  fstatSync: fs.fstatSync.bind(fs),
  readlinkSync: fs.readlinkSync.bind(fs),
  readFileSync: fs.readFileSync.bind(fs),
  writeFileSync: fs.writeFileSync.bind(fs),
};
const role = process.env.KRN_D1_ROLE;
const root = path.resolve(process.env.KRN_D1_ROOT);
const lock = path.resolve(process.env.KRN_D1_LOCK);
const reclaimer = path.resolve(process.env.KRN_D1_RECLAIMER);
function identity() {
  const stat = original.readFileSync('/proc/' + process.pid + '/stat', 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/u);
  return { pid: process.pid, startTicks: fields[19] };
}
function put(name, value = identity()) {
  original.writeFileSync(path.join(root, name), JSON.stringify(value), { flag: 'wx', mode: 0o600 });
}
function waitFor(name) {
  const deadline = Date.now() + 10000;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (original.existsSync(path.join(root, name))) return;
    Atomics.wait(cell, 0, 0, 5);
  }
  throw new Error('D1 barrier timed out: ' + name);
}
let bPaused = false;
let aPaused = false;
let aEexists = false;
fs.existsSync = function (pathArg, ...args) {
  const actual = original.existsSync(pathArg, ...args);
  const normalized = path.resolve(String(pathArg));
  if (role === 'B' && normalized === reclaimer && !actual && !bPaused) {
    bPaused = true;
    put('B_RECLAIMER_ABSENT.json', { ...identity(), actual, reclaimer });
    waitFor('RELEASE_B_GATE.json');
  }
  if (role === 'A' && normalized === lock && !actual && !aPaused && original.existsSync(reclaimer)) {
    aPaused = true;
    put('A_PRIMARY_ABSENT.json', { ...identity(), actual, reclaimerExists: true });
    waitFor('RELEASE_A_CREATE.json');
  }
  return actual;
};
fs.openSync = function (pathArg, flags, ...args) {
  const normalized = path.resolve(String(pathArg));
  try {
    const fd = original.openSync(pathArg, flags, ...args);
    if (role === 'B' && normalized === lock && (Number(flags) & fs.constants.O_EXCL) !== 0) {
      const stats = original.fstatSync(fd);
      put('B_PRIMARY_OPEN.json', { ...identity(), fd, flags, dev: stats.dev, ino: stats.ino, nlink: stats.nlink, fdPath: original.readlinkSync('/proc/self/fd/' + fd) });
    }
    return fd;
  } catch (error) {
    if (role === 'A' && normalized === lock && (Number(flags) & fs.constants.O_EXCL) !== 0 && error?.code === 'EEXIST' && !aEexists) {
      aEexists = true;
      put('A_PRIMARY_EEXIST.json', { ...identity(), code: error.code, errno: error.errno, syscall: error.syscall, path: error.path });
    }
    throw error;
  }
};
fs.fsyncSync = function (fd) {
  let fdPath;
  try { fdPath = original.readlinkSync('/proc/self/fd/' + fd); } catch {}
  if (role === 'B' && fdPath === lock) {
    const stats = original.fstatSync(fd);
    put('B_PRIMARY_PREFSYNC.json', { ...identity(), fd, fdPath, dev: stats.dev, ino: stats.ino, nlink: stats.nlink, bytes: original.readFileSync(lock, 'utf8') });
    waitFor('RELEASE_B_FSYNC.json');
  }
  return original.fsyncSync(fd);
};
syncBuiltinESMExports();
put(role + '_BOOT.json', { ...identity(), role });
`,
      { mode: 0o600 },
    );
    await writeFile(
      workerPath,
      `
import { readFileSync, writeFileSync } from 'node:fs';
const role = process.env.KRN_D1_ROLE;
const root = process.env.KRN_D1_ROOT;
const job = JSON.parse(readFileSync(process.env.KRN_D1_JOB, 'utf8'));
const sha = role === 'A' ? 'a'.repeat(40) : 'b'.repeat(40);
let outcome;
try {
  const { verdict } = await import(process.env.KRN_D1_TRACE_URL);
  await verdict(job, { sha, checks: [{ id: 'gate', exitCode: 0, durationMs: 1, sha256: sha.padEnd(64, '0') }] });
  outcome = { kind: 'resolved' };
} catch (error) {
  outcome = { kind: 'rejected', name: error?.name, code: error?.code, message: error?.message };
}
writeFileSync(root + '/' + role + '_RESULT.json', JSON.stringify({ role, pid: process.pid, outcome }), { flag: 'wx', mode: 0o600 });
process.stdout.write(JSON.stringify({ role, outcome }) + '\\n');
`,
      { mode: 0o600 },
    );

    staleOwner = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      staleOwner?.once('spawn', resolve);
      staleOwner?.once('error', reject);
    });
    assert.ok(staleOwner.pid);
    const staleTicks = processStartTicks(staleOwner.pid);
    assert.ok(staleTicks);
    staleIdentity = { pid: staleOwner.pid, startTicks: staleTicks };
    assert.equal(
      processHasIdentity(staleIdentity.pid, staleIdentity.startTicks),
      true,
    );
    staleOwnerClosed = new Promise((resolve) =>
      staleOwner?.once('close', (_code, signal) => resolve(signal)),
    );
    staleOwner.kill('SIGTERM');
    const staleSignal = await staleOwnerClosed;
    assert.equal(staleSignal, 'SIGTERM');
    assert.equal(
      processHasIdentity(staleIdentity.pid, staleIdentity.startTicks),
      false,
    );

    const staleOwnerRecord = { ...staleIdentity, token: randomUUID() };
    const staleBytes = Buffer.from(JSON.stringify(staleOwnerRecord));
    const staleFd = openSync(
      lockPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      assert.equal(writeSync(staleFd, staleBytes), staleBytes.length);
      fsyncSync(staleFd);
    } finally {
      closeSync(staleFd);
    }

    const b = await start('B');
    const bAbsent = await waitFor('B_RECLAIMER_ABSENT.json');
    assert.ok(bAbsent, 'B must observe the real reclaimer path absent');
    assert.equal(bAbsent.actual, false);
    const a = await start('A');
    const aAbsent = await waitFor('A_PRIMARY_ABSENT.json');
    assert.ok(
      aAbsent,
      'A must remove the verified stale owner under its reclaimer',
    );
    assert.equal(aAbsent.actual, false);
    assert.equal(aAbsent.reclaimerExists, true);
    await marker('RELEASE_B_GATE.json');
    const bOpened = await waitFor('B_PRIMARY_OPEN.json');
    const bPreFsync = await waitFor('B_PRIMARY_PREFSYNC.json');
    assert.ok(
      bOpened,
      'B must perform an actual O_EXCL create of the primary lock',
    );
    assert.ok(
      bPreFsync,
      'B must pause after writing its real lock, before fsync',
    );
    assert.equal(bOpened.pid, b.identity?.pid);
    assert.equal(
      bOpened.flags && (bOpened.flags as number) & constants.O_EXCL,
      constants.O_EXCL,
    );
    assert.equal(bOpened.nlink, 1);
    assert.equal(bOpened.fdPath, lockPath);
    assert.equal(bPreFsync.pid, b.identity?.pid);
    assert.equal(bPreFsync.fdPath, lockPath);
    assert.equal(bPreFsync.nlink, 1);
    const publishedOwner = JSON.parse(String(bPreFsync.bytes)) as {
      pid: number;
      startTicks: string;
      token: string;
    };
    assert.deepEqual(publishedOwner, {
      pid: b.identity?.pid,
      startTicks: b.identity?.startTicks,
      token: publishedOwner.token,
    });
    await marker('RELEASE_A_CREATE.json');
    const aCollision = await waitFor('A_PRIMARY_EEXIST.json');
    assert.ok(
      aCollision,
      'A must observe B’s actual O_EXCL primary-lock collision',
    );
    assert.equal(aCollision.code, 'EEXIST');
    assert.equal(aCollision.syscall, 'open');
    await marker('RELEASE_B_FSYNC.json');

    const aResult = await waitFor('A_RESULT.json');
    const bResult = await waitFor('B_RESULT.json');
    assert.ok(aResult && bResult, 'both public verdict calls must settle');
    const aClosed = await a.closed;
    const bClosed = await b.closed;
    assert.equal(aClosed.code, 0, `A stderr=${aClosed.stderr}`);
    assert.equal(bClosed.code, 0, `B stderr=${bClosed.stderr}`);
    assert.equal(aClosed.stderr, '');
    assert.equal(bClosed.stderr, '');
    const aIdentity = a.identity;
    const bIdentity = b.identity;
    assert.ok(
      aIdentity && bIdentity,
      'both worker identities must be retained',
    );
    assert.equal(
      processHasIdentity(aIdentity.pid, aIdentity.startTicks),
      false,
    );
    assert.equal(
      processHasIdentity(bIdentity.pid, bIdentity.startTicks),
      false,
    );

    const traceBytes = readFileSync(f.tracePath);
    const rows = traceBytes
      .toString('utf8')
      .trim()
      .split('\n')
      .map(
        (line) => JSON.parse(line) as { kind: string; data: { sha: string } },
      );
    const evidence = {
      staleOwner: {
        identity: staleIdentity,
        wasLiveBeforeTermination: true,
        signal: staleSignal,
        goneBeforeLockRecord: true,
      },
      A: { identity: a.identity, result: aResult, close: aClosed },
      B: { identity: b.identity, result: bResult, close: bClosed },
      barrierFacts: {
        B_reclaimer_absent: bAbsent,
        A_primary_absent_under_reclaimer: aAbsent,
      },
      realLockFacts: {
        B_primary_open: bOpened,
        B_before_fsync: bPreFsync,
        A_EEXIST: aCollision,
      },
      durableRows: rows,
      primaryLockAbsent: !existsSync(lockPath),
      reclaimerAbsent: !existsSync(reclaimerPath),
    };
    const evidencePath = process.env.KRN_D1_EVIDENCE;
    if (evidencePath) {
      await mkdir(dirname(evidencePath), { recursive: true });
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    }

    assert.deepEqual(
      [aResult.outcome, bResult.outcome],
      [{ kind: 'resolved' }, { kind: 'resolved' }],
      'both concurrent public verdict calls must resolve after the reclaimer race',
    );
    assert.deepEqual(rows.map((row) => row.data.sha).sort(), [
      'a'.repeat(40),
      'b'.repeat(40),
    ]);
    assert.ok(rows.every((row) => row.kind === 'verdict'));
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(reclaimerPath), false);
  } finally {
    await Promise.all(
      [
        'RELEASE_B_GATE.json',
        'RELEASE_A_CREATE.json',
        'RELEASE_B_FSYNC.json',
      ].map((name) => marker(name)),
    );
    for (const item of children) {
      const settled = await Promise.race([
        item.closed,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
      ]);
      if (
        settled === null &&
        item.identity &&
        processHasIdentity(item.identity.pid, item.identity.startTicks)
      ) {
        item.child.kill('SIGTERM');
        const afterTerm = await Promise.race([
          item.closed,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
        ]);
        if (
          afterTerm === null &&
          processHasIdentity(item.identity.pid, item.identity.startTicks)
        )
          item.child.kill('SIGKILL');
        await item.closed;
      }
    }
    if (staleOwner && staleOwnerClosed && staleIdentity) {
      const gone = await Promise.race([
        staleOwnerClosed.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1000)),
      ]);
      if (
        !gone &&
        processHasIdentity(staleIdentity.pid, staleIdentity.startTicks)
      )
        staleOwner.kill('SIGKILL');
      if (!gone) await staleOwnerClosed;
    }
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
