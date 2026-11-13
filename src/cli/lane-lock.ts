import { mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Block the thread for `ms` milliseconds; lane steps are synchronous child processes. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Take the lock file when it is free or its holder died; false while a live process holds it. */
function tryLock(file: string): boolean {
  try {
    const descriptor = openSync(file, 'wx');
    writeSync(descriptor, String(process.pid));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  let holder = Number.NaN;
  try {
    holder = Number(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  // An empty file is a holder between open and write; only a dead pid is stale.
  if (!Number.isInteger(holder) || holder <= 0 || alive(holder)) return false;
  rmSync(file, { force: true });
  return false;
}

/**
 * Run `operation` while holding the lock file `file` (its holder's pid), so concurrent lanes of one
 * repository take turns; a lock left by a dead process is taken over.
 */
export function withFileLock<T>(
  file: string,
  operation: () => T,
  pollMs = 200,
): T {
  mkdirSync(dirname(file), { recursive: true });
  while (!tryLock(file)) sleepSync(pollMs);
  try {
    return operation();
  } finally {
    rmSync(file, { force: true });
  }
}
