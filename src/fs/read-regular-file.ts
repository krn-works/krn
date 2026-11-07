import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Read a regular file reached without symlinks, refusing more than limit bytes. */
export function readRegularFile(
  path: string,
  limit: number,
  label: string,
): string {
  // Open the resolved path, so `link/..` cannot leave the checked parent.
  const full = resolve(path);
  const parent = dirname(full);
  if (realpathSync(parent) !== parent)
    throw new Error(`${label} path must not pass through a symlink`);
  if (!lstatSync(full).isFile())
    throw new Error(`${label} must be a regular non-symlink file`);
  const fd = openSync(
    full,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
    if (stat.size > limit) throw new Error(`${label} exceeds ${limit} bytes`);
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > limit) throw new Error(`${label} exceeds ${limit} bytes`);
    const contents = bytes.subarray(0, size);
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
        contents,
      );
      const hasBom =
        contents[0] === 0xef && contents[1] === 0xbb && contents[2] === 0xbf;
      return hasBom ? `\uFEFF${decoded}` : decoded;
    } catch {
      throw new Error(`${label} must be UTF-8 text`);
    }
  } finally {
    closeSync(fd);
  }
}
