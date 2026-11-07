import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Job } from '../core/index.ts';
import { repoRecord } from '../foreman/state.ts';
export class UnlinkedTraceLockObservationError extends Error {}

export function assertNoTraceSymlinks(directory: string, path: string): void {
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

export function ensureTraceDirectoryAtRoot(
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

export function ensureTraceDirectory(
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

export function assertTraceFileIsRegularIfPresent(path: string): void {
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

export function openVerifiedTrace(
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
