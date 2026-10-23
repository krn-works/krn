// Hold a host flock through a pipe whose EOF releases the child holder.
import { spawn } from 'node:child_process';
import { closeSync, constants, fchmodSync, openSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

export interface HostLockLease {
  readonly signal: AbortSignal | undefined;
  assertHeld(): void;
  release(): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validateHostLockPath(path: string): void {
  if (!isAbsolute(path))
    throw new Error('--host-lock must be an absolute path');
  let parentIsDirectory: boolean;
  try {
    parentIsDirectory = statSync(dirname(path)).isDirectory();
  } catch {
    throw new Error('--host-lock parent must exist and be a directory');
  }
  if (!parentIsDirectory)
    throw new Error('--host-lock parent must exist and be a directory');
}

function ensureLockFile(path: string): void {
  try {
    const descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      fchmodSync(descriptor, 0o600);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw new Error(
        `unable to create --host-lock file: ${errorMessage(error)}`,
      );
  }
  try {
    if (!statSync(path).isFile())
      throw new Error('--host-lock must name a regular file');
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === '--host-lock must name a regular file'
    )
      throw error;
    throw new Error(
      `unable to access --host-lock file: ${errorMessage(error)}`,
    );
  }
}

export async function acquireHostLock(
  path: string,
  signal?: AbortSignal,
): Promise<HostLockLease> {
  validateHostLockPath(path);
  ensureLockFile(path);

  const child = spawn(
    'flock',
    ['--exclusive', path, 'sh', '-c', 'echo locked; exec cat >/dev/null'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const holderFailure = new AbortController();
  const combinedSignal = signal
    ? AbortSignal.any([signal, holderFailure.signal])
    : holderFailure.signal;
  let failure: Error | undefined;
  let releasing = false;
  let output = '';
  let stderr = '';
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  child.once('close', () => resolveClosed());
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2048);
  });
  child.stdin.on('error', () => {});

  let ready = false;
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    holderFailure.abort(error);
    if (!ready) rejectReady(error);
  };
  child.once('error', (error) => {
    fail(new Error(`unable to start flock for --host-lock: ${error.message}`));
  });
  child.once('exit', (code, childSignal) => {
    if (releasing) return;
    const detail = stderr.trim();
    fail(
      new Error(
        `flock holder exited before release (${code === null ? childSignal : code})${detail ? `: ${detail}` : ''}`,
      ),
    );
  });
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output = `${output}${chunk}`.slice(-4096);
    if (!ready && /(?:^|\n)locked\r?\n/u.test(output)) {
      ready = true;
      resolveReady();
    }
  });

  const abortAcquisition = () => {
    const reason = signal?.reason;
    fail(
      new Error(
        `host lock acquisition aborted${reason === undefined ? '' : `: ${errorMessage(reason)}`}`,
      ),
    );
    child.stdin.end();
    child.kill('SIGTERM');
  };
  if (signal?.aborted) abortAcquisition();
  else signal?.addEventListener('abort', abortAcquisition, { once: true });

  try {
    await readyPromise;
  } catch (error) {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM');
    await closed;
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortAcquisition);
  }

  const assertHeld = () => {
    if (failure)
      throw new Error(`host lock holder failed: ${failure.message}`, {
        cause: failure,
      });
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('host lock holder exited before release');
  };

  return {
    signal: combinedSignal,
    assertHeld,
    async release() {
      if (releasing) return;
      releasing = true;
      child.stdin.end();
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      timeout.unref();
      await closed;
      clearTimeout(timeout);
    },
  };
}
