import {
  closeSync,
  constants,
  type Dirent,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

export class LocalReadError extends Error {
  readonly reason: 'missing' | 'unsafe' | 'oversized' | 'entry-limit';
  constructor(reason: 'missing' | 'unsafe' | 'oversized' | 'entry-limit') {
    super(reason);
    this.reason = reason;
  }
}

function fail(reason: LocalReadError['reason']): never {
  throw new LocalReadError(reason);
}
function readlinkFd(fd: number): string {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return '';
  }
}

export function openVerifiedDirectory(path: string): number {
  const absolute = resolve(path);
  const name = absolute.slice(absolute.lastIndexOf('/') + 1);
  let parent: number | undefined;
  if (absolute !== '/') parent = openVerifiedDirectory(dirname(absolute));
  let fd: number;
  try {
    fd = openSync(
      parent === undefined ? '/' : `/proc/self/fd/${parent}/${name}`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (parent !== undefined) closeSync(parent);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('missing');
    fail('unsafe');
  }
  try {
    if (!fstatSync(fd).isDirectory() || readlinkFd(fd) !== absolute)
      fail('unsafe');
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  } finally {
    if (parent !== undefined) closeSync(parent);
  }
}

export function openVerifiedFile(
  path: string,
  limit: number,
): { fd: number; size: number } {
  const absolute = resolve(path);
  const parent = openVerifiedDirectory(dirname(absolute));
  let fd: number;
  try {
    fd = openSync(
      `/proc/self/fd/${parent}/${path.slice(path.lastIndexOf('/') + 1)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('missing');
    fail('unsafe');
  } finally {
    closeSync(parent);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || readlinkFd(fd) !== absolute) fail('unsafe');
    if (stat.size > limit) fail('oversized');
    return { fd, size: stat.size };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function readBoundedFile(path: string, limit: number): Buffer {
  const { fd } = openVerifiedFile(path, limit);
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > limit) fail('oversized');
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

export function listVerifiedDirectory(fd: number, limit: number): Dirent[] {
  let dir: ReturnType<typeof opendirSync>;
  try {
    dir = opendirSync(`/proc/self/fd/${fd}`);
  } catch {
    fail('unsafe');
  }
  try {
    const entries: Dirent[] = [];
    while (entries.length <= limit) {
      const entry = dir.readSync();
      if (entry === null) break;
      entries.push(entry);
    }
    if (entries.length > limit) fail('entry-limit');
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    dir.closeSync();
  }
}

// Walk every ancestor with lstat from the root down: a symlinked component
// is unsafe even when its target is missing; the first absent component
// makes the path missing.
function verifyAncestors(path: string): void {
  const parent = dirname(resolve(path));
  const parts = parent.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    let stat: Stats;
    try {
      stat = lstatSync(current);
    } catch (error) {
      fail(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'missing'
          : 'unsafe',
      );
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe');
  }
  let real: string;
  try {
    real = realpathSync(parent);
  } catch {
    fail('unsafe');
  }
  if (real !== parent) fail('unsafe');
}
export function lstatVerified(path: string): Stats {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('unsafe');
    // An absent target under a symlinked ancestor is unsafe, not missing.
    verifyAncestors(path);
    fail('missing');
  }
  verifyAncestors(path);
  return stat;
}
export function lstatVerifiedIfPresent(path: string): Stats | undefined {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('unsafe');
    // An absent target under a symlinked ancestor is unsafe, not absent.
    try {
      verifyAncestors(path);
    } catch (ancestor) {
      if (ancestor instanceof LocalReadError && ancestor.reason === 'missing')
        return undefined;
      throw ancestor;
    }
    return undefined;
  }
  verifyAncestors(path);
  return stat;
}
