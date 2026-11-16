// Host-wide cap on headless claude sessions started by eval runners. A session takes one slot file
// under a host directory before it starts and gives it back when it ends; a slot whose owner died is
// reclaimed. KRN_EVAL_MAX_SESSIONS (default 4) is the cap, KRN_EVAL_SLOT_DIR moves the directory.
// Shell use: node evals/session-slot.ts run -- <command> [args...] (exit code of the command).
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MAX_SESSIONS = 4;

export function maxSessions(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.KRN_EVAL_MAX_SESSIONS);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_SESSIONS;
}

const slotDir = (env: NodeJS.ProcessEnv) =>
  env.KRN_EVAL_SLOT_DIR ??
  join(tmpdir(), `krn-eval-sessions-${userInfo().uid}`);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

function tryTake(dir: string, cap: number): string | undefined {
  for (let i = 0; i < cap; i++) {
    const file = join(dir, `slot-${i}`);
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx' });
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const owner = Number(readFileSync(file, 'utf8').trim());
    if (!Number.isInteger(owner) || owner <= 0 || !alive(owner)) {
      // One reclaimer wins the rename; the others see the slot missing and retry.
      try {
        renameSync(file, `${file}.stale-${process.pid}`);
        rmSync(`${file}.stale-${process.pid}`, { force: true });
      } catch {
        // Another reclaimer already took it.
      }
      i--;
    }
  }
  return undefined;
}

/** Waits for a free slot (printing the wait to stderr) and returns the function that gives it back. */
export async function takeSessionSlot(
  env: NodeJS.ProcessEnv = process.env,
  pollMs = 500,
): Promise<() => void> {
  const dir = slotDir(env);
  const cap = maxSessions(env);
  mkdirSync(dir, { recursive: true });
  let waited = 0;
  for (;;) {
    const file = tryTake(dir, cap);
    if (file !== undefined) {
      if (waited > 0)
        console.error(
          `session slot taken after ${(waited / 1000).toFixed(1)}s`,
        );
      return () => rmSync(file, { force: true });
    }
    if (waited === 0)
      console.error(
        `waiting for a session slot: ${cap} headless sessions already run (KRN_EVAL_MAX_SESSIONS=${cap})`,
      );
    await new Promise((r) => setTimeout(r, pollMs));
    waited += pollMs;
  }
}

/** Runs `fn` while holding one slot. */
export async function withSessionSlot<T>(
  fn: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const release = await takeSessionSlot(env);
  try {
    return await fn();
  } finally {
    release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [verb, sep, cmd, ...args] = process.argv.slice(2);
  if (verb !== 'run' || sep !== '--' || !cmd) {
    console.error(
      'usage: node evals/session-slot.ts run -- <command> [args...]',
    );
    process.exit(64);
  }
  const release = await takeSessionSlot();
  const child = spawn(cmd, args, { stdio: 'inherit' });
  for (const sig of ['SIGTERM', 'SIGINT'] as const)
    process.on(sig, () => child.kill(sig));
  child.on('error', () => {
    release();
    process.exit(127);
  });
  child.on('close', (code, signal) => {
    release();
    process.exit(code ?? (signal ? 128 : 1));
  });
}
