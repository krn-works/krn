// Trace writer lock: exclusive, owner-recorded, crash-recoverable lock beside the trace file. ADR 0001.
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  processHasIdentity,
  processStartTicks,
} from '../hosts/systemd-scope.ts';
import {
  assertNoTraceSymlinks,
  assertTraceFileIsRegularIfPresent,
  openVerifiedTrace,
  UnlinkedTraceLockObservationError,
} from './files.ts';
import { TRACE_LOCK_WAIT_MS } from './lock-wait.ts';

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

const traceLockWaitMs = TRACE_LOCK_WAIT_MS;
const traceLockPollMs = 10;
const traceLockWaitCell = new Int32Array(new SharedArrayBuffer(4));

function waitForTraceLock(): void {
  Atomics.wait(traceLockWaitCell, 0, 0, traceLockPollMs);
}

function traceLockPathWasReleased(path: string): boolean {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || (stats.nlink !== 0 && stats.nlink !== 1))
      throw new Error('unsafe trace lock');
    // lstat can resolve an inode just before its owner unlinks it. This
    // observation grants no ownership; retry acquisition from the path.
    if (stats.nlink === 0) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return false;
}

export function readTraceLockOwner(path: string): TraceLockOwnerObservation {
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
  if (traceLockPathWasReleased(path))
    throw Object.assign(new Error('trace lock was released'), {
      code: 'EEXIST',
    });
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

export function acquireTraceLock(
  directory: string,
  tracePath: string,
): () => void {
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
    if (
      traceLockPathWasReleased(lockPath) ||
      traceLockPathWasReleased(reclaimerPath)
    ) {
      waitForTraceLock();
      continue;
    }
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
