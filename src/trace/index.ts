// Trace is append-only so a resumed worker can distinguish durable checkpoints. ADR 0001.

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  readFileSync,
  readSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Job } from '../core/index.ts';
import { readCheckpointRequest } from '../foreman/checkpoint-request.ts';
import { credentialShapeKind } from '../foreman/credential-shape.ts';
import { repoRecord, stateDirectory } from '../foreman/state.ts';
import type { SessionEnd } from '../foreman/types.ts';
import {
  codexScopeUnit,
  type SystemdScopeRegistration,
  validateSystemdScopeRegistration,
} from '../hosts/systemd-scope.ts';
import type { VerdictEvent } from '../verdict/index.ts';
import {
  assertNoTraceSymlinks,
  assertTraceFileIsRegularIfPresent,
  ensureTraceDirectory,
  ensureTraceDirectoryAtRoot,
  openVerifiedTrace,
} from './files.ts';
import { acquireTraceLock, readTraceLockOwner } from './lock.ts';

type Event = {
  readonly key: string;
  readonly kind: string;
  readonly at: string;
  readonly data: Record<string, unknown>;
};

export type ReadonlyTraceEvent = Readonly<{
  key: string;
  kind: string;
  at: string;
  data: Readonly<Record<string, unknown>>;
}>;

export type ReadonlyTraceSnapshot = Readonly<{
  jobId: string;
  events: readonly ReadonlyTraceEvent[];
  sha256: string;
  byteLength: number;
  malformedTail: boolean;
  finalRowUnterminated: boolean;
}>;

const readonlyRepoContextSchema = z.object({
  repoRoot: z.string().min(1),
  gitDir: z.string().min(1),
  gitWorkTree: z.string().min(1),
});

export type ReadonlyTraceRepoContext = Readonly<
  z.infer<typeof readonlyRepoContextSchema>
>;

const eventSchema = z.object({
  key: z.string(),
  kind: z.string(),
  at: z.string(),
  data: z.record(z.string(), z.unknown()),
});
const verdictDataSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40,64}$/iu),
  checks: z.array(
    z.object({
      id: z.string(),
      exitCode: z.number().int(),
      durationMs: z.number().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/iu),
    }),
  ),
});
const jobOutcomeSchema = z.object({
  exitCode: z.number().int().min(0).max(255),
  signal: z.enum(['SIGINT', 'SIGTERM', 'SIGHUP', 'wall-timeout']).nullable(),
  cleanup: z.enum(['verified', 'unconfirmed']),
  reason: z.enum([
    'completed',
    'stopped',
    'wall-timeout',
    'runjob-error',
    'cleanup-unconfirmed',
    'trace-error',
  ]),
  outcomeKind: z.enum(['verdict_pass', 'review', 'stop', 'error']).optional(),
  error: z
    .object({ type: z.string().min(1).max(64), message: z.string().max(240) })
    .optional(),
});
const traceSnapshotMaxBytes = 33_554_432;
const traceSnapshotMaxRows = 100_000;
function file(job: Job): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(job.id) || job.id === '..')
    throw new Error('invalid trace job id');
  return join(stateDirectory(job), 'trace.jsonl');
}

function parseEvent(line: string): Event {
  const value: unknown = JSON.parse(line);
  return eventSchema.parse(value);
}

function writeAllSync(fd: number, value: string): void {
  const bytes = Buffer.from(value);
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written < 1) throw new Error('trace write made no progress');
    offset += written;
  }
}

type TraceSnapshot = {
  readonly events: Event[];
  readonly path: string;
  readonly directory: string;
  readonly bytes: Buffer;
  readonly malformedTail: boolean;
  readonly finalRowUnterminated: boolean;
  readonly repairOffset: number;
};

function emptyTraceSnapshot(path: string, directory: string): TraceSnapshot {
  return {
    events: [],
    path,
    directory,
    bytes: Buffer.alloc(0),
    malformedTail: false,
    finalRowUnterminated: false,
    repairOffset: 0,
  };
}

function readSnapshotBytes(fd: number, size: number): Buffer {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, null);
    if (count === 0) throw new Error('trace changed while reading');
    offset += count;
  }
  return bytes;
}

function assertSnapshotRowLimit(bytes: Buffer, maxRows: number): void {
  let rows = 0;
  let rowHasBytes = false;
  for (const byte of bytes) {
    if (byte === 0x0a) {
      if (rowHasBytes) rows += 1;
      rowHasBytes = false;
    } else rowHasBytes = true;
    if (rows > maxRows) throw new Error('trace snapshot exceeds event limit');
  }
  if (rowHasBytes && rows === maxRows)
    throw new Error('trace snapshot exceeds event limit');
}

function readTraceContents(
  path: string,
  ensureDirectory: () => boolean,
  requireStableRead: boolean,
  snapshotLimits?: Readonly<{ maxBytes: number; maxRows: number }>,
): TraceSnapshot {
  const directory = dirname(path);
  if (!ensureDirectory()) return emptyTraceSnapshot(path, directory);
  assertNoTraceSymlinks(directory, path);
  if (!existsSync(path)) return emptyTraceSnapshot(path, directory);
  let contents: Buffer;
  try {
    const fd = openVerifiedTrace(path, constants.O_RDONLY);
    try {
      if (requireStableRead) {
        const before = fstatSync(fd);
        if (snapshotLimits && before.size > snapshotLimits.maxBytes)
          throw new Error('trace snapshot exceeds byte limit');
        contents = snapshotLimits
          ? readSnapshotBytes(fd, before.size)
          : readFileSync(fd);
        const after = fstatSync(fd);
        if (snapshotLimits && after.size > snapshotLimits.maxBytes)
          throw new Error('trace snapshot exceeds byte limit');
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new Error('trace changed while reading');
      } else {
        contents = readFileSync(fd);
      }
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return emptyTraceSnapshot(path, directory);
    throw error;
  }
  if (snapshotLimits) assertSnapshotRowLimit(contents, snapshotLimits.maxRows);
  const terminated = contents.length === 0 || contents.at(-1) === 0x0a;
  const lastNewline = contents.lastIndexOf(0x0a);
  const completeLength = terminated ? contents.length : lastNewline + 1;
  const result = contents
    .subarray(0, completeLength)
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map(parseEvent);
  if (terminated || contents.length === 0)
    return {
      events: result,
      path,
      directory,
      bytes: contents,
      malformedTail: false,
      finalRowUnterminated: false,
      repairOffset: contents.length,
    };

  const tail = contents.subarray(completeLength).toString('utf8');
  try {
    result.push(parseEvent(tail));
  } catch {
    console.warn('krn trace: discarded torn final trace line');
    return {
      events: result,
      path,
      directory,
      bytes: contents,
      malformedTail: true,
      finalRowUnterminated: false,
      repairOffset: completeLength,
    };
  }

  return {
    events: result,
    path,
    directory,
    bytes: contents,
    malformedTail: false,
    finalRowUnterminated: true,
    repairOffset: contents.length,
  };
}

function readTrace(job: Job): TraceSnapshot {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(job.id) || job.id === '..')
    throw new Error('invalid trace job id');
  const repositoryRoot = realpathSync(repoRecord(job).repoRoot);
  const path = join(
    repositoryRoot,
    '.krn',
    'runs',
    'foreman',
    job.id,
    'trace.jsonl',
  );
  const directory = dirname(path);
  return readTraceContents(
    path,
    () => ensureTraceDirectoryAtRoot(repositoryRoot, directory, false),
    false,
  );
}

function assertNoTraceWriterLocks(directory: string, tracePath: string): void {
  assertTraceFileIsRegularIfPresent(tracePath);
  for (const lockPath of [`${tracePath}.lock`, `${tracePath}.lock.reclaim`]) {
    assertNoTraceSymlinks(directory, lockPath);
    const observed = readTraceLockOwner(lockPath);
    if (observed.kind !== 'absent')
      throw new Error('trace is locked or its lock owner is invalid');
  }
}

export function readTraceSnapshot(
  repoRoot: string,
  jobId: string,
): ReadonlyTraceSnapshot {
  if (
    !isAbsolute(repoRoot) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId)
  )
    throw new Error('invalid trace snapshot location');
  const repositoryRoot = resolve(repoRoot);
  const repositoryRootStats = lstatSync(repositoryRoot);
  if (
    repositoryRootStats.isSymbolicLink() ||
    !repositoryRootStats.isDirectory() ||
    realpathSync(repositoryRoot) !== repositoryRoot
  )
    throw new Error('unsafe trace path');
  const path = join(
    repositoryRoot,
    '.krn',
    'runs',
    'foreman',
    jobId,
    'trace.jsonl',
  );
  const directory = dirname(path);
  assertNoTraceWriterLocks(directory, path);
  const snapshot = readTraceContents(
    path,
    () => ensureTraceDirectoryAtRoot(repositoryRoot, directory, false),
    true,
    { maxBytes: traceSnapshotMaxBytes, maxRows: traceSnapshotMaxRows },
  );
  assertNoTraceWriterLocks(directory, path);
  const immutableEvents = Object.freeze(
    snapshot.events.map((event) =>
      Object.freeze({ ...event, data: Object.freeze(event.data) }),
    ),
  );
  return Object.freeze({
    jobId,
    events: immutableEvents,
    sha256: createHash('sha256').update(snapshot.bytes).digest('hex'),
    byteLength: snapshot.bytes.length,
    malformedTail: snapshot.malformedTail,
    finalRowUnterminated: snapshot.finalRowUnterminated,
  });
}

export function readTraceRepoContext(
  repoRoot: string,
  jobId: string,
): ReadonlyTraceRepoContext | null {
  if (
    !isAbsolute(repoRoot) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId)
  )
    throw new Error('invalid trace repository context location');
  const repositoryRoot = resolve(repoRoot);
  const rootStats = lstatSync(repositoryRoot);
  if (
    rootStats.isSymbolicLink() ||
    !rootStats.isDirectory() ||
    realpathSync(repositoryRoot) !== repositoryRoot
  )
    throw new Error('unsafe trace path');
  const path = join(
    repositoryRoot,
    '.krn',
    'runs',
    'foreman',
    jobId,
    'repo.json',
  );
  const directory = dirname(path);
  if (!ensureTraceDirectoryAtRoot(repositoryRoot, directory, false))
    return null;
  assertNoTraceSymlinks(directory, path);
  let fd: number;
  try {
    fd = openVerifiedTrace(path, constants.O_RDONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const before = fstatSync(fd);
    if (before.size > 16 * 1024) throw new Error('invalid repo descriptor');
    const contents = readSnapshotBytes(fd, before.size).toString('utf8');
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('repo descriptor changed while reading');
    const parsed = readonlyRepoContextSchema.parse(
      JSON.parse(contents) as unknown,
    );
    if (
      !isAbsolute(parsed.repoRoot) ||
      !isAbsolute(parsed.gitDir) ||
      !isAbsolute(parsed.gitWorkTree) ||
      resolve(parsed.repoRoot) !== parsed.repoRoot ||
      resolve(parsed.gitDir) !== parsed.gitDir ||
      resolve(parsed.gitWorkTree) !== parsed.gitWorkTree
    )
      throw new Error('invalid repo descriptor paths');
    return Object.freeze(parsed);
  } finally {
    closeSync(fd);
  }
}

function events(job: Job): Event[] {
  return readTrace(job).events;
}

function repairTraceTail(snapshot: TraceSnapshot): void {
  if (snapshot.malformedTail) {
    const fd = openVerifiedTrace(snapshot.path, constants.O_RDWR);
    try {
      ftruncateSync(fd, snapshot.repairOffset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } else if (snapshot.finalRowUnterminated) {
    const fd = openVerifiedTrace(
      snapshot.path,
      constants.O_WRONLY | constants.O_APPEND,
    );
    try {
      writeAllSync(fd, '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

function append(
  job: Job,
  key: string,
  kind: string,
  data: Record<string, unknown>,
): boolean {
  const path = file(job);
  const directory = dirname(path);
  ensureTraceDirectory(job, directory, true);
  assertNoTraceSymlinks(directory, path);
  const releaseLock = acquireTraceLock(directory, path);
  try {
    const snapshot = readTrace(job);
    repairTraceTail(snapshot);
    if (snapshot.events.some((event) => event.key === key)) {
      const fd = openVerifiedTrace(
        path,
        constants.O_WRONLY | constants.O_APPEND,
      );
      try {
        if (!fstatSync(fd).isFile()) throw new Error('unsafe trace path');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return false;
    }
    assertNoTraceSymlinks(directory, path);
    const fd = openVerifiedTrace(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
      0o600,
    );
    try {
      if (!fstatSync(fd).isFile()) throw new Error('unsafe trace path');
      writeAllSync(
        fd,
        `${JSON.stringify({ id: randomUUID(), key, kind, at: new Date().toISOString(), data })}\n`,
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return true;
  } finally {
    releaseLock();
  }
}

export async function intent(job: Job, epoch: number): Promise<string> {
  const key = `intent:${epoch}`;
  append(job, key, 'intent', { jobId: job.id, epoch });
  return key;
}

export async function started(
  job: Job,
  intentId: string,
  sessionId: string,
  pgid?: number,
  isolation?: 'pid_namespace' | 'systemd_scope',
  registration?: SystemdScopeRegistration,
): Promise<boolean> {
  let expectedUnit: string | undefined;
  let scopeRegistration: SystemdScopeRegistration | undefined;
  if (isolation === 'systemd_scope') {
    try {
      expectedUnit = codexScopeUnit(job.id, sessionId);
    } catch {
      throw new Error('invalid Codex scope registration identity');
    }
    scopeRegistration = validateSystemdScopeRegistration(
      registration,
      expectedUnit,
    );
    if (!scopeRegistration)
      throw new Error('systemd scope registration witness is invalid');
  } else if (registration !== undefined) {
    throw new Error(
      'systemd scope registration has no matching isolation mode',
    );
  }
  // Session starts are unique by opaque host identity, while the intent key fences retries.
  const sessionKey = `${intentId}:session`;
  const matchesSession = (event: Event): boolean => {
    if (event.data.sessionId !== sessionId) return false;
    if (!scopeRegistration) return true;
    const previous = validateSystemdScopeRegistration(
      event.data.scopeRegistration,
      expectedUnit ?? '',
    );
    return (
      event.data.jobId === job.id &&
      event.data.isolation === 'systemd_scope' &&
      previous !== undefined &&
      previous.controlGroup === scopeRegistration.controlGroup &&
      previous.pid === scopeRegistration.pid &&
      previous.startTicks === scopeRegistration.startTicks
    );
  };
  const appended = append(job, sessionKey, 'session_started', {
    intent: intentId,
    jobId: job.id,
    sessionId,
    ...(pgid === undefined ? {} : { pgid }),
    sandbox: 'workspace-write',
    isolation: isolation ?? 'unknown',
    ...(scopeRegistration === undefined ? {} : { scopeRegistration }),
  });
  if (appended) return true;
  const winner = events(job).find((event) => event.key === sessionKey);
  return (
    winner?.kind === 'session_started' &&
    winner.data.intent === intentId &&
    winner.data.jobId === job.id &&
    matchesSession(winner)
  );
}

export async function checkpoint(
  job: Job,
  intentId: string,
  sessionId: string,
  message: string,
  next: string,
  _decision?: string,
): Promise<void> {
  const request = await checkpointRequest(job, intentId, sessionId);
  if (!request || request.message !== message || request.next !== next)
    throw new Error('checkpoint request is missing or stale');
  append(job, `${intentId}:checkpoint:${sessionId}`, 'checkpoint', {
    intent: intentId,
    sessionId,
    message,
    next,
    ...(request.decision === undefined ? {} : { decision: request.decision }),
  });
}

export async function checkpointRequest(
  job: Job,
  intentId: string,
  sessionId: string,
): Promise<{
  readonly message: string;
  readonly next: string;
  readonly decision?: string;
} | null> {
  const trace = events(job);
  const started = trace.find((event) => event.key === `${intentId}:session`);
  if (started?.data.sessionId !== sessionId) return null;
  const request = readCheckpointRequest(job, sessionId);
  return request?.intent === intentId && request.sessionId === sessionId
    ? {
        message: request.message,
        next: request.next,
        ...(request.decision === undefined
          ? {}
          : { decision: request.decision }),
      }
    : null;
}

export async function commit(
  job: Job,
  intentId: string,
  sessionId: string,
  sha: string,
  message: string,
): Promise<void> {
  if (!/^[a-f0-9]{40,64}$/i.test(sha))
    throw new Error('commit SHA is malformed');
  const request = await checkpointRequest(job, intentId, sessionId);
  if (!request || request.message !== message)
    throw new Error('commit does not match the bound checkpoint request');
  const key = `${intentId}:commit:${sessionId}`;
  const prior = events(job).find((event) => event.key === key);
  if (prior) {
    if (prior.data.sha !== sha || prior.data.message !== message)
      throw new Error('commit conflicts with the recorded session commit');
    return;
  }
  append(job, key, 'commit', {
    intent: intentId,
    sessionId,
    sha,
    message,
  });
}

export async function hasCheckpoint(
  job: Job,
  intentId: string,
  sessionId: string,
): Promise<boolean> {
  return (await checkpointRequest(job, intentId, sessionId)) !== null;
}

export async function sessionEnd(
  job: Job,
  sessionId: string,
): Promise<SessionEnd | null> {
  const trace = events(job);
  const value = trace.find(
    (event) =>
      event.kind === 'session_ended' && event.data.sessionId === sessionId,
  )?.data.end;
  const parsed = z
    .object({ reasonKind: z.string(), claimsDone: z.boolean() })
    .safeParse(value);
  if (!parsed.success) return null;
  const completed = trace.some(
    (event) =>
      event.kind === 'checkpoint' &&
      event.data.sessionId === sessionId &&
      event.data.next === 'done',
  );
  return { ...parsed.data, claimsDone: completed };
}

export async function sessionScopeRegistration(
  job: Job,
  sessionId: string,
): Promise<SystemdScopeRegistration | null> {
  const started = events(job).find(
    (event) =>
      event.kind === 'session_started' &&
      event.data.jobId === job.id &&
      event.data.sessionId === sessionId,
  );
  if (started?.data.isolation !== 'systemd_scope') return null;
  let expectedUnit: string;
  try {
    expectedUnit = codexScopeUnit(job.id, sessionId);
  } catch {
    return null;
  }
  return (
    validateSystemdScopeRegistration(
      started.data.scopeRegistration,
      expectedUnit,
    ) ?? null
  );
}

export async function sessionLost(
  job: Job,
  sessionId: string,
  dirtyPaths: readonly string[],
): Promise<void> {
  append(job, `session-lost:${sessionId}`, 'session_lost', {
    sessionId,
    dirtyPaths,
  });
}

export async function log(
  job: Job,
  intentId: string,
  sessionId: string,
  event: 'session_ended',
  end: SessionEnd,
): Promise<void> {
  append(job, `${intentId}:ended:${sessionId}`, event, {
    intent: intentId,
    sessionId,
    end: {
      exitCode: end.exitCode,
      signal: end.signal,
      threadId: end.threadId,
      usage: end.usage,
      usageObservation: end.usageObservation,
      reasonKind: end.reasonKind,
      reasonSha256: end.reasonSha256,
      reasonLength: end.reasonLength,
      claimsDone: end.claimsDone,
    },
  });
}

export async function failure(
  job: Job,
  intentId: string,
  error: unknown,
): Promise<void> {
  append(job, `${intentId}:failure`, 'failure', {
    errorType: safeErrorType(error),
  });
}

export async function verdict(job: Job, event: VerdictEvent): Promise<void> {
  const data = {
    sha: event.sha,
    checks: event.checks.map(({ id, exitCode, durationMs, sha256 }) => ({
      id,
      exitCode,
      durationMs,
      sha256,
    })),
  };
  const resultHash = createHash('sha256')
    .update(JSON.stringify(data))
    .digest('hex');
  append(job, `verdict:${event.sha}:${resultHash}`, 'verdict', data);
}

export async function hasVerdict(job: Job, sha: string): Promise<boolean> {
  return events(job).some((event) => {
    if (event.kind !== 'verdict') return false;
    const parsed = verdictDataSchema.parse(event.data);
    return (
      parsed.sha === sha && parsed.checks.every((check) => check.exitCode === 0)
    );
  });
}

export async function stopped(job: Job, signal: string): Promise<void> {
  append(job, `stopped:${randomUUID()}`, 'stopped', { signal });
}

export async function teardownUnconfirmed(
  job: Job,
  detail: string,
): Promise<void> {
  append(job, `teardown-unconfirmed:${randomUUID()}`, 'teardown_unconfirmed', {
    detail: detail.slice(0, 1000),
  });
}

export function jobOutcome(
  job: Job,
  input: Omit<z.input<typeof jobOutcomeSchema>, 'error'> & {
    readonly error?: unknown;
  },
): void {
  const normalized = {
    exitCode: input.exitCode,
    signal: input.signal,
    cleanup: input.cleanup,
    reason: input.reason,
    ...(input.outcomeKind === undefined
      ? {}
      : { outcomeKind: input.outcomeKind }),
    ...(input.error === undefined ? {} : { error: boundedError(input.error) }),
  };
  append(
    job,
    `job-outcome:${randomUUID()}`,
    'job_outcome',
    jobOutcomeSchema.parse(normalized),
  );
}

export async function readyForReview(job: Job, sha: string): Promise<void> {
  append(job, `ready-for-review:${sha}`, 'ready_for_review', { sha });
}

export async function operatorStart(job: Job, operator: string): Promise<void> {
  append(job, `operator-start:${randomUUID()}`, 'operator_start', { operator });
}

export async function operatorStop(job: Job, operator: string): Promise<void> {
  append(job, `operator-stop:${randomUUID()}`, 'operator_stop', { operator });
}

const genericCredentialTokenClasses = [
  /[a-z]/u,
  /[A-Z]/u,
  /[0-9]/u,
  /[_+=/-]/u,
] as const;

function isSafeGenericCredentialToken(token: string): boolean {
  if (
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(
      token,
    )
  )
    return true;
  return (
    /^[A-Z]{2,}-\d+$/u.test(token) ||
    /^krn-[A-Z]+-\d+(?:-[a-z0-9]+)*$/u.test(token)
  );
}

function containsGenericCredentialToken(note: string): boolean {
  return note.split(/\s+/u).some((token) => {
    if (token.length < 20 || isSafeGenericCredentialToken(token)) return false;
    let characterClasses = 0;
    for (const pattern of genericCredentialTokenClasses) {
      if (pattern.test(token)) characterClasses += 1;
    }
    return characterClasses >= 2;
  });
}

function containsInterventionCredential(note: string): boolean {
  return (
    /\b(?:(?:sk|rk|pk)_(?:live|test)_|whsec_|sk[-_])/u.test(note) ||
    /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|glpat-)/u.test(note) ||
    /\bgithub_pat_/u.test(note) ||
    /\bxox[baprs]-/u.test(note) ||
    /(?:AKIA|ASIA)[0-9A-Z]{16}/u.test(note) ||
    /AIza[0-9A-Za-z_-]{35}/u.test(note) ||
    /\bBasic\s+[A-Za-z0-9+/=]{16,}/iu.test(note) ||
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u.test(note) ||
    /Bearer\s+\S+/iu.test(note) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(note) ||
    /(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/iu.test(note) ||
    containsGenericCredentialToken(note)
  );
}

const safeErrorTypes = new Set([
  'AbortError',
  'AggregateError',
  'AssertionError',
  'DOMException',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'SystemError',
  'TimeoutError',
  'TypeError',
  'URIError',
  'bigint',
  'boolean',
  'function',
  'number',
  'object',
  'string',
  'symbol',
  'undefined',
]);

export function safeErrorType(error: unknown): string {
  let candidate: unknown;
  try {
    candidate = error instanceof Error ? error.name : typeof error;
  } catch {
    return 'Error';
  }
  if (
    typeof candidate !== 'string' ||
    !safeErrorTypes.has(candidate) ||
    credentialShapeKind(candidate) !== null ||
    containsInterventionCredential(candidate)
  )
    return 'Error';
  return candidate;
}

function boundedError(error: unknown): { type: string; message: string } {
  const fallbackMessage = 'Error details unavailable';
  try {
    const type = safeErrorType(error);
    let rawMessage = fallbackMessage;
    try {
      if (error instanceof Error) {
        const candidateMessage: unknown = error.message;
        if (typeof candidateMessage === 'string') rawMessage = candidateMessage;
      } else if (
        error === null ||
        (typeof error !== 'object' && typeof error !== 'function')
      ) {
        rawMessage = String(error);
      }
    } catch {
      rawMessage = fallbackMessage;
    }

    if (rawMessage.length > 4096) return { type, message: 'message omitted' };
    const compact = rawMessage.replace(/\s+/gu, ' ').trim();
    const message =
      credentialShapeKind(compact) || containsInterventionCredential(compact)
        ? '[redacted]'
        : compact.slice(0, 240);
    return { type, message };
  } catch {
    return { type: 'Error', message: fallbackMessage };
  }
}

export async function leadIntervention(
  job: Job,
  kind: 'intervention' | 'reconstruction_prompt',
  note: string,
): Promise<void> {
  if (!note || note.length > 200 || /[\r\n]/u.test(note))
    throw new Error(
      'lead intervention note must be a single line of at most 200 characters',
    );
  if (
    credentialShapeKind(note) !== null ||
    containsInterventionCredential(note)
  )
    throw new Error('lead intervention note must not contain credentials');
  append(job, `lead-intervention:${randomUUID()}`, 'lead_intervention', {
    kind,
    note,
  });
}
