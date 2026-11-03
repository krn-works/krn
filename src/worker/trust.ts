import { createHash } from 'node:crypto';
import {
  constants,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { isMissing, readBytes, secureDir, WorkerError } from './state.ts';

export function workerTmp(run: string): string {
  const tmp = join(realpathSync(run), 'tmp');
  secureDir(tmp);
  return tmp;
}

export const stateDigest = (path: string) =>
  createHash('sha256')
    .update(readBytes(path, 2 * 1024 * 1024))
    .digest('hex');

export const savedStateDigest = (state: unknown) =>
  createHash('sha256').update(JSON.stringify(state)).digest('hex');

// Taken immediately before each turn, when the driver has finished its writes.
// Driver outputs are written only after this comparison has completed.
export function runBaseline(run: string): () => string[] {
  function snapshot() {
    const files = new Map<string, string>();
    let entries = 0;
    let bytes = 0;
    function walk(path: string) {
      if (++entries > 10000)
        throw new WorkerError(65, 'worker run paths exceed 10000');
      const full = join(run, path);
      const stat = lstatSync(full);
      if (path === 'tmp' && stat.isDirectory() && !stat.isSymbolicLink())
        return;
      let fingerprint = `${stat.mode & constants.S_IFMT}:${stat.mode & 0o777}:${stat.isDirectory() ? 0 : stat.size}`;
      if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 1024 * 1024 * 1024)
          throw new WorkerError(65, 'worker run contents exceed 1 GB');
        fingerprint += `:${createHash('sha256')
          .update(readBytes(full, 1024 * 1024 * 1024))
          .digest('hex')}`;
      } else if (stat.isSymbolicLink()) fingerprint += `:${readlinkSync(full)}`;
      files.set(path, fingerprint);
      if (stat.isDirectory())
        for (const entry of readdirSync(full)) walk(join(path, entry));
    }
    secureDir(run, false);
    for (const entry of readdirSync(run)) walk(entry);
    return files;
  }
  const before = snapshot();
  return () => {
    let after: Map<string, string>;
    try {
      after = snapshot();
    } catch (error) {
      if (error instanceof WorkerError || isMissing(error)) return [run];
      throw error;
    }
    return [...new Set([...before.keys(), ...after.keys()])]
      .filter((path) => before.get(path) !== after.get(path))
      .map((path) => join(run, path));
  };
}
