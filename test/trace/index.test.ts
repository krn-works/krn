import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
