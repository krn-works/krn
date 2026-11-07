// Worktree setup markers: one install at a time, others wait on a live PID. Pattern from t3code scripts/setup-worktree.ts.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const waitMs = 5 * 60_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function runningPid(file: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(file, 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Run `install` once per worktree; a concurrent caller waits for the live installer, then rechecks `ready`. */
export function ensureSetup(
  repo: string,
  ready: () => boolean,
  install: () => { ok: boolean; detail: string },
): boolean {
  if (ready()) return true;
  const dir = join(repo, '.krn', 'setup');
  const running = join(dir, 'running');
  const done = join(dir, 'done');
  const failed = join(dir, 'failed');
  mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + waitMs;
  while (runningPid(running) !== undefined && Date.now() < deadline)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  if (ready()) return true;
  rmSync(done, { force: true });
  rmSync(failed, { force: true });
  writeFileSync(running, `${process.pid}\n`);
  try {
    const result = install();
    if (result.ok && ready()) writeFileSync(done, '');
    else writeFileSync(failed, `${result.detail}\n`);
    return result.ok && ready();
  } finally {
    rmSync(running, { force: true });
  }
}
