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
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Job } from '../core/index.ts';
import { readCheckpointRequest } from '../foreman/checkpoint-request.ts';
import { credentialShapeKind } from '../foreman/credential-shape.ts';
import { repoRecord, stateDirectory } from '../foreman/state.ts';
import type { SessionEnd, SubmissionPersistence } from '../foreman/types.ts';
import {
  codexScopeUnit,
  processHasIdentity,
  processStartTicks,
  type SystemdScopeRegistration,
  validateSystemdScopeRegistration,
} from '../hosts/systemd-scope.ts';
import type {
  ConflictCommentDelivery,
  ReviewSubmission,
  SubmissionReceipt,
} from '../ledger/index.ts';
import type { VerdictEvent } from '../verdict/index.ts';
import { TRACE_LOCK_WAIT_MS } from './lock-wait.ts';

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

type TraceFdPathVerification = 'verified' | 'unavailable' | 'mismatch';

export function classifyTraceFdPathReadback(
  actualPath: string | undefined,
  errorCode: string | undefined,
  expectedPath: string,
): TraceFdPathVerification {
  if (actualPath === expectedPath) return 'verified';
  if (
    actualPath === undefined &&
    (errorCode === 'ENOENT' || errorCode === 'ENOTDIR')
  )
    return 'unavailable';
  return 'mismatch';
}

export function traceFdPathVerificationDecision(
  verification: TraceFdPathVerification,
): 'ok' | 'refusal' {
  return verification === 'verified' ? 'ok' : 'refusal';
}

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
const traceLockOwnerSchema = z.object({
  pid: z.number().int().positive(),
  startTicks: z.string().regex(/^\d+$/u),
  token: z.string().uuid(),
});
type TraceLockOwnerObservation =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unlinked' }
  | { readonly kind: 'publishing'; readonly dev: number; readonly ino: number }
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'owner';
      readonly owner: z.infer<typeof traceLockOwnerSchema>;
      readonly dev: number;
      readonly ino: number;
    };

class UnlinkedTraceLockObservationError extends Error {}
const traceLockWaitMs = TRACE_LOCK_WAIT_MS;
const traceSnapshotMaxBytes = 33_554_432;
const traceSnapshotMaxRows = 100_000;
const traceLockPollMs = 10;
const traceLockWaitCell = new Int32Array(new SharedArrayBuffer(4));

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

function assertNoTraceSymlinks(directory: string, path: string): void {
  const relativePath = relative(directory, path);
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  )
    throw new Error('unsafe trace path');

  const assertNotSymlink = (componentPath: string): void => {
    try {
      if (lstatSync(componentPath).isSymbolicLink())
        throw new Error('unsafe trace path');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  const ancestors: string[] = [];
  let ancestor = directory;
  while (true) {
    ancestors.unshift(ancestor);
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  for (const componentPath of ancestors) assertNotSymlink(componentPath);

  let current = directory;
  for (const component of relativePath.split(sep)) {
    current = join(current, component);
    assertNotSymlink(current);
  }
}

function isWithinOrSame(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function nearestExistingRealpath(path: string): string {
  let current = resolve(path);
  while (true) {
    try {
      lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('unsafe trace path');
      const parent = dirname(current);
      if (parent === current) throw new Error('unsafe trace path');
      current = parent;
      continue;
    }
    try {
      return realpathSync(current);
    } catch {
      throw new Error('unsafe trace path');
    }
  }
}

function ensureTraceDirectoryAtRoot(
  repositoryRoot: string,
  directory: string,
  create: boolean,
): boolean {
  const repoRoot = realpathSync(repositoryRoot);
  if (repoRoot !== resolve(repositoryRoot))
    throw new Error('unsafe trace path');
  let rootStats: ReturnType<typeof lstatSync>;
  try {
    rootStats = lstatSync(repoRoot);
  } catch {
    throw new Error('unsafe trace path');
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory())
    throw new Error('unsafe trace path');
  const expectedDirectory = resolve(directory);
  if (
    expectedDirectory === repoRoot ||
    !isWithinOrSame(repoRoot, expectedDirectory)
  )
    throw new Error('unsafe trace path');

  const nearest = nearestExistingRealpath(expectedDirectory);
  if (!isWithinOrSame(repoRoot, nearest)) throw new Error('unsafe trace path');
  assertNoTraceSymlinks(repoRoot, expectedDirectory);

  const createdDirectories: Array<{
    path: string;
    dev?: number;
    ino?: number;
  }> = [];
  try {
    if (create) {
      let current = repoRoot;
      for (const component of relative(repoRoot, expectedDirectory).split(
        sep,
      )) {
        current = join(current, component);
        let createdDirectory:
          | { path: string; dev?: number; ino?: number }
          | undefined;
        try {
          lstatSync(current);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw new Error('unsafe trace path');
          try {
            mkdirSync(current, { mode: 0o700 });
            createdDirectory = { path: current };
            createdDirectories.push(createdDirectory);
          } catch (mkdirError) {
            if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST')
              throw new Error('unsafe trace path');
          }
        }

        let stats: ReturnType<typeof lstatSync>;
        try {
          stats = lstatSync(current);
        } catch {
          throw new Error('unsafe trace path');
        }
        if (
          createdDirectory &&
          stats.isDirectory() &&
          !stats.isSymbolicLink()
        ) {
          createdDirectory.dev = stats.dev;
          createdDirectory.ino = stats.ino;
        }
        if (stats.isSymbolicLink() || !stats.isDirectory())
          throw new Error('unsafe trace path');
      }
    } else {
      try {
        lstatSync(expectedDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw new Error('unsafe trace path');
      }
    }

    let actualDirectory: string;
    try {
      actualDirectory = realpathSync(expectedDirectory);
    } catch {
      throw new Error('unsafe trace path');
    }
    if (actualDirectory !== expectedDirectory)
      throw new Error('unsafe trace path');
    assertNoTraceSymlinks(repoRoot, expectedDirectory);
    return true;
  } catch {
    for (const createdDirectory of createdDirectories.reverse()) {
      try {
        const stats = lstatSync(createdDirectory.path);
        if (
          createdDirectory.dev !== undefined &&
          createdDirectory.ino !== undefined &&
          stats.isDirectory() &&
          !stats.isSymbolicLink() &&
          stats.dev === createdDirectory.dev &&
          stats.ino === createdDirectory.ino
        )
          rmdirSync(createdDirectory.path);
      } catch {
        // Only empty directories created by this invocation are removed.
      }
    }
    throw new Error('unsafe trace path');
  }
}

function ensureTraceDirectory(
  job: Job,
  directory: string,
  create: boolean,
): boolean {
  return ensureTraceDirectoryAtRoot(
    repoRecord(job).repoRoot,
    directory,
    create,
  );
}

function assertTraceFileIsRegularIfPresent(path: string): void {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stats.isFile() || stats.nlink !== 1)
    throw new Error('unsafe trace path');
}

function openTraceFile(path: string, flags: number, mode?: number): number {
  assertTraceFileIsRegularIfPresent(path);
  try {
    return openSync(
      path,
      flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      mode,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new Error('unsafe trace path');
    throw error;
  }
}

function openVerifiedTrace(
  path: string,
  flags: number,
  mode?: number,
  allowUnlinkedLockObservation = false,
): number {
  let fd: number;
  let createdByOpen = false;
  if ((flags & constants.O_CREAT) !== 0) {
    try {
      fd = openTraceFile(path, flags | constants.O_EXCL, mode);
      createdByOpen = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      fd = openTraceFile(path, flags & ~constants.O_CREAT, mode);
    }
  } else {
    fd = openTraceFile(path, flags);
  }

  let actualPath: string | undefined;
  let readbackErrorCode: string | undefined;
  try {
    actualPath = readlinkSync(`/proc/self/fd/${fd}`);
  } catch (error) {
    readbackErrorCode = (error as NodeJS.ErrnoException).code;
  }
  const pathVerification = classifyTraceFdPathReadback(
    actualPath,
    readbackErrorCode,
    resolve(path),
  );
  if (traceFdPathVerificationDecision(pathVerification) === 'refusal') {
    if (
      allowUnlinkedLockObservation &&
      path.endsWith('.lock') &&
      flags === constants.O_RDONLY &&
      pathVerification === 'mismatch' &&
      actualPath === `${resolve(path)} (deleted)`
    ) {
      let unlinkedStats: ReturnType<typeof fstatSync> | undefined;
      try {
        unlinkedStats = fstatSync(fd);
      } catch {
        // An unreadable descriptor retains the normal fail-closed path below.
      }
      if (unlinkedStats?.isFile() && unlinkedStats.nlink === 0) {
        closeSync(fd);
        throw new UnlinkedTraceLockObservationError(
          'verified trace lock was unlinked after open',
        );
      }
    }
    let cleanupPath: string | undefined;
    let openedStats: ReturnType<typeof fstatSync> | undefined;
    if (createdByOpen && pathVerification === 'mismatch') {
      try {
        openedStats = fstatSync(fd);
        if (openedStats.isFile() && openedStats.size === 0)
          cleanupPath = realpathSync(`/proc/self/fd/${fd}`);
      } catch {
        // Keep the refusal even if procfs cannot provide a cleanup path.
      }
    }
    closeSync(fd);
    if (
      cleanupPath !== undefined &&
      cleanupPath !== resolve(path) &&
      openedStats !== undefined
    ) {
      try {
        const currentStats = lstatSync(cleanupPath);
        if (
          currentStats.isFile() &&
          currentStats.size === 0 &&
          currentStats.dev === openedStats.dev &&
          currentStats.ino === openedStats.ino
        )
          unlinkSync(cleanupPath);
      } catch {
        // The path is still rejected if cleanup is no longer possible.
      }
    }
    throw new Error('unsafe trace path');
  }
  const openedStats = fstatSync(fd);
  if (
    allowUnlinkedLockObservation &&
    path.endsWith('.lock') &&
    flags === constants.O_RDONLY &&
    openedStats.isFile() &&
    openedStats.nlink === 0
  ) {
    closeSync(fd);
    throw new UnlinkedTraceLockObservationError(
      'verified trace lock was unlinked after open',
    );
  }
  if (!openedStats.isFile() || openedStats.nlink !== 1) {
    closeSync(fd);
    throw new Error('unsafe trace path');
  }
  return fd;
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

function waitForTraceLock(): void {
  Atomics.wait(traceLockWaitCell, 0, 0, traceLockPollMs);
}

function assertTraceLockPath(path: string): void {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.nlink !== 1)
      throw new Error('unsafe trace lock');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function readTraceLockOwner(path: string): TraceLockOwnerObservation {
  let fd: number;
  try {
    fd = openVerifiedTrace(path, constants.O_RDONLY, undefined, true);
  } catch (error) {
    if (error instanceof UnlinkedTraceLockObservationError)
      return { kind: 'unlinked' };
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { kind: 'absent' };
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    if (stats.size === 0)
      return { kind: 'publishing', dev: stats.dev, ino: stats.ino };
    if (stats.size > 1024) return { kind: 'invalid' };
    try {
      const parsed = traceLockOwnerSchema.safeParse(
        JSON.parse(readFileSync(fd, 'utf8')) as unknown,
      );
      if (!parsed.success) return { kind: 'invalid' };
      return {
        kind: 'owner',
        owner: parsed.data,
        dev: stats.dev,
        ino: stats.ino,
      };
    } catch {
      // A writer may have been interrupted while publishing its short JSON
      // owner. Acquisition retries within its existing bounded deadline, then
      // refuses a persistent malformed file without attempting reclamation.
      return { kind: 'invalid' };
    }
  } catch {
    return { kind: 'invalid' };
  } finally {
    closeSync(fd);
  }
}

function lockOwnerIsLive(
  owner: z.infer<typeof traceLockOwnerSchema>,
): boolean | undefined {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code !== 'EPERM') return undefined;
  }
  const ticks = processStartTicks(owner.pid);
  if (ticks === undefined) return undefined;
  if (ticks !== owner.startTicks) return false;
  return processHasIdentity(owner.pid, owner.startTicks);
}

function createTraceLock(
  path: string,
  owner: z.infer<typeof traceLockOwnerSchema>,
): { readonly dev: number; readonly ino: number } {
  assertTraceLockPath(path);
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let identity: { readonly dev: number; readonly ino: number } | undefined;
  let completed = false;
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.nlink !== 1)
      throw new Error('unsafe trace lock');
    const expectedPath = resolve(path);
    let actualPath: string;
    try {
      actualPath = readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      throw new Error('unsafe trace lock');
    }
    if (actualPath !== expectedPath) throw new Error('unsafe trace lock');
    identity = { dev: stats.dev, ino: stats.ino };
    const bytes = Buffer.from(JSON.stringify(owner));
    const written = writeSync(fd, bytes);
    if (written !== bytes.length)
      throw new Error('trace lock write was incomplete');
    fsyncSync(fd);
    completed = true;
    return identity;
  } finally {
    closeSync(fd);
    if (!completed && identity) {
      try {
        const current = lstatSync(path);
        if (
          current.isFile() &&
          current.nlink === 1 &&
          current.dev === identity.dev &&
          current.ino === identity.ino
        )
          unlinkSync(path);
      } catch {
        // Failed lock creation leaves paths it cannot prove owned untouched.
      }
    }
  }
}

function removeTraceLockIfOwned(
  path: string,
  owner: z.infer<typeof traceLockOwnerSchema>,
  identity: { readonly dev: number; readonly ino: number },
): void {
  try {
    const current = readTraceLockOwner(path);
    if (
      current.kind === 'owner' &&
      current?.owner.token === owner.token &&
      current.dev === identity.dev &&
      current.ino === identity.ino
    )
      unlinkSync(path);
  } catch {
    // Ownership is not established, so the path is left untouched.
  }
}

function acquireTraceLock(directory: string, tracePath: string): () => void {
  const lockPath = `${tracePath}.lock`;
  const reclaimerPath = `${tracePath}.lock.reclaim`;
  assertTraceFileIsRegularIfPresent(tracePath);
  const startTicks = processStartTicks(process.pid);
  if (!startTicks)
    throw new Error('cannot establish trace lock owner identity');
  const owner = { pid: process.pid, startTicks, token: randomUUID() };
  const deadline = Date.now() + traceLockWaitMs;

  while (Date.now() < deadline) {
    assertNoTraceSymlinks(directory, lockPath);
    assertNoTraceSymlinks(directory, reclaimerPath);
    assertTraceLockPath(lockPath);
    assertTraceLockPath(reclaimerPath);
    if (existsSync(reclaimerPath)) {
      waitForTraceLock();
      continue;
    }
    try {
      const identity = createTraceLock(lockPath, owner);
      return () => removeTraceLockIfOwned(lockPath, owner, identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const observed = readTraceLockOwner(lockPath);
    if (observed.kind === 'unlinked') {
      waitForTraceLock();
      continue;
    }
    if (observed.kind !== 'owner') {
      waitForTraceLock();
      continue;
    }
    const live = lockOwnerIsLive(observed.owner);
    if (live === undefined) throw new Error('cannot verify trace lock owner');
    if (live) {
      // Continue observing the same process identity while it publishes or
      // fsyncs the trace; the shared deadline still bounds a stuck live owner.
      waitForTraceLock();
      continue;
    }

    // A single O_EXCL reclaimer gate serializes stale-owner removal. Every
    // contender rereads the canonical owner after acquiring the gate, so one
    // reclaimer cannot unlink a replacement writer's live lock.
    let reclaimerIdentity: { readonly dev: number; readonly ino: number };
    try {
      reclaimerIdentity = createTraceLock(reclaimerPath, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        waitForTraceLock();
        continue;
      }
      throw error;
    }
    let acquired: { readonly dev: number; readonly ino: number } | undefined;
    try {
      const current = readTraceLockOwner(lockPath);
      if (
        current.kind === 'owner' &&
        current.owner.token === observed.owner.token &&
        current.dev === observed.dev &&
        current.ino === observed.ino &&
        lockOwnerIsLive(current.owner) === false
      ) {
        unlinkSync(lockPath);
      }
      if (!existsSync(lockPath)) {
        try {
          acquired = createTraceLock(lockPath, owner);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
    } finally {
      removeTraceLockIfOwned(reclaimerPath, owner, reclaimerIdentity);
    }
    if (acquired) {
      const identity = acquired;
      return () => removeTraceLockIfOwned(lockPath, owner, identity);
    }
  }
  const finalOwner = readTraceLockOwner(lockPath);
  if (finalOwner.kind === 'invalid')
    throw new Error('invalid trace lock owner');
  throw new Error('trace lock acquisition timed out');
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

export async function submitIntent(
  job: Job,
  sha: string,
  contractRevision: string,
): Promise<boolean> {
  const priorForSha = events(job).some(
    (event) => event.kind === 'submit_intent' && event.data.sha === sha,
  );
  const key = `submit-intent:${sha}:${contractRevision}`;
  const created = append(job, key, 'submit_intent', { sha, contractRevision });
  return priorForSha || !created;
}

export async function submittedFor(
  job: Job,
  sha: string,
): Promise<SubmissionReceipt | null> {
  const event = events(job).find(
    (candidate) => candidate.kind === 'submitted' && candidate.data.sha === sha,
  );
  if (!event) return null;
  const parsed = z
    .object({
      issueId: z.string().min(1),
      status: z.string().min(1),
      updatedAt: z.string().min(1),
    })
    .safeParse(event.data.receipt);
  return parsed.success ? parsed.data : null;
}

export function submitted(
  job: Job,
  sha: string,
  receipt: SubmissionReceipt,
): void {
  append(job, `submitted:${sha}`, 'submitted', { sha, receipt });
}

export async function submissionWindowFor(
  job: Job,
  sha: string,
): Promise<readonly string[] | null> {
  if (!/^[a-f0-9]{40,64}$/iu.test(sha))
    throw new Error('commit SHA is malformed');
  const event = events(job).find(
    (candidate) =>
      candidate.kind === 'submission_window' && candidate.data.sha === sha,
  );
  if (!event) return null;
  const parsed = z
    .object({
      sha: z.string().regex(/^[a-f0-9]{40,64}$/iu),
      eventIds: z.array(z.string().min(1)).max(20_000),
    })
    .safeParse(event.data);
  if (!parsed.success || parsed.data.sha !== sha)
    throw new Error('persisted submission window is invalid');
  return parsed.data.eventIds;
}

export function submissionWindow(
  job: Job,
  sha: string,
  eventIds: readonly string[],
): void {
  if (!/^[a-f0-9]{40,64}$/iu.test(sha))
    throw new Error('commit SHA is malformed');
  if (
    eventIds.length > 20_000 ||
    eventIds.some((eventId) => typeof eventId !== 'string' || !eventId)
  )
    throw new Error('submission window is invalid');
  const key = `submission-window:${sha}`;
  const prior = events(job).find((event) => event.key === key);
  if (prior) {
    const parsed = z
      .object({
        sha: z.string().regex(/^[a-f0-9]{40,64}$/iu),
        eventIds: z.array(z.string().min(1)).max(20_000),
      })
      .safeParse(prior.data);
    if (
      !parsed.success ||
      parsed.data.sha !== sha ||
      JSON.stringify(parsed.data.eventIds) !== JSON.stringify(eventIds)
    )
      throw new Error('persisted submission window conflicts');
    return;
  }
  append(job, key, 'submission_window', { sha, eventIds });
}

export async function submissionReconciliationFor(
  job: Job,
  sha: string,
): Promise<ReviewSubmission | null> {
  if (!/^[a-f0-9]{40,64}$/iu.test(sha))
    throw new Error('commit SHA is malformed');
  const event = events(job)
    .filter(
      (candidate) =>
        candidate.kind === 'submission_reconciliation' &&
        candidate.data.sha === sha,
    )
    .at(-1);
  if (!event) return null;
  const parsed = z
    .object({
      sha: z.string().regex(/^[a-f0-9]{40,64}$/iu),
      result: z.enum([
        'submitted',
        'ready_for_review',
        'stopped',
        'refused',
        'board_changed',
        'board_conflict',
      ]),
    })
    .safeParse(event.data);
  if (!parsed.success || parsed.data.sha !== sha)
    throw new Error('persisted submission reconciliation is invalid');
  return parsed.data.result;
}

export function submissionReconciliation(
  job: Job,
  sha: string,
  result: ReviewSubmission,
): void {
  if (!/^[a-f0-9]{40,64}$/iu.test(sha))
    throw new Error('commit SHA is malformed');
  append(
    job,
    `submission-reconciliation:${sha}:${randomUUID()}`,
    'submission_reconciliation',
    { sha, result },
  );
}

export async function conflictCommentFor(
  job: Job,
  sha: string,
): Promise<ConflictCommentDelivery | null> {
  if (!/^[a-f0-9]{40,64}$/iu.test(sha))
    throw new Error('commit SHA is malformed');
  const event = events(job)
    .filter(
      (candidate) =>
        candidate.kind === 'conflict_comment_delivery' &&
        candidate.data.sha === sha,
    )
    .at(-1);
  if (!event) return null;
  const parsed = z
    .object({
      sha: z.string().regex(/^[a-f0-9]{40,64}$/iu),
      state: z.enum(['pending', 'delivered']),
      body: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/iu),
    })
    .safeParse(event.data);
  if (
    !parsed.success ||
    parsed.data.sha !== sha ||
    createHash('sha256').update(parsed.data.body).digest('hex') !==
      parsed.data.sha256
  )
    throw new Error('persisted conflict comment delivery is invalid');
  return {
    state: parsed.data.state,
    body: parsed.data.body,
    sha256: parsed.data.sha256,
  };
}

export function conflictComment(
  job: Job,
  sha: string,
  delivery: ConflictCommentDelivery,
): void {
  if (
    !/^[a-f0-9]{40,64}$/iu.test(sha) ||
    createHash('sha256').update(delivery.body).digest('hex') !== delivery.sha256
  )
    throw new Error('conflict comment delivery is invalid');
  append(
    job,
    `conflict-comment:${sha}:${delivery.sha256}:${delivery.state}`,
    'conflict_comment_delivery',
    { sha, ...delivery },
  );
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

export function paperclipUpdateStarted(
  job: Job,
  sha: string,
  kind: 'review' | 'conflict_comment',
): void {
  append(
    job,
    `paperclip-update-started:${randomUUID()}`,
    'paperclip_update_started',
    {
      sha,
      kind,
    },
  );
}

export const submissionPersistence = {
  submitIntent,
  submittedFor,
  submitted,
  submissionWindowFor,
  submissionWindow,
  submissionReconciliationFor,
  submissionReconciliation,
  conflictCommentFor,
  conflictComment,
  paperclipUpdateStarted,
} satisfies SubmissionPersistence;

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
