import { lstatSync, opendirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readRegularFile } from '../brief/index.ts';

class WorkerBusyError extends Error {
  readonly exitCode = 75;
}

/** Read status only; task commands do not depend on worker state schemas. */
export function assertWorkerIdle(root: string): void {
  const runs = join(root, '.krn/runs');
  let entries = 0;
  const directory = (path: string): boolean => {
    try {
      return lstatSync(path).isDirectory();
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return false;
      throw new WorkerBusyError(`cannot inspect run entries in ${root}`);
    }
  };
  if (!directory(join(root, '.krn')) || !directory(runs)) return;
  function scan(path: string, depth: number): void {
    const dir = opendirSync(path);
    try {
      for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
        if (++entries > 4096) throw new WorkerBusyError('too many run entries');
        const child = join(path, entry.name);
        const stat = lstatSync(child);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory() && depth < 3) scan(child, depth + 1);
        else if (entry.name === 'session.json' && stat.isFile()) {
          let text: string;
          try {
            text = readRegularFile(child, 64 * 1024, 'session');
          } catch {
            // An unreadable or oversized session may still be live: refuse.
            throw new WorkerBusyError(
              `cannot read worker session ${child}; run krn worker stop --run ${dirname(child)}`,
            );
          }
          let data: unknown;
          try {
            data = JSON.parse(text);
          } catch {
            continue;
          }
          if (
            typeof data === 'object' &&
            data !== null &&
            'status' in data &&
            data.status === 'running'
          )
            throw new WorkerBusyError(
              `worktree ${root} has an open worker session ${child}; run krn worker stop --run ${dirname(child)}`,
            );
        }
      }
    } finally {
      dir.closeSync();
    }
  }
  try {
    scan(runs, 0);
  } catch (error) {
    if (error instanceof WorkerBusyError) throw error;
    throw new WorkerBusyError(`cannot inspect run entries in ${root}`);
  }
}
