// Host-wide cap on headless claude sessions started by eval runners. A session takes one slot file
// under a host directory before it starts and gives it back when it ends; a slot whose owner died is
// reclaimed. KRN_EVAL_MAX_SESSIONS (default 4) is the cap, KRN_EVAL_SLOT_DIR moves the directory.
// Shell use: node evals/session-slot.ts run -- <command> [args...] (exit code of the command).
import { spawn } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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

/** A slot file without an owner pid younger than this is a crashed writer's leftover only after it ages. */
const UNOWNED_GRACE_MS = 10_000;

const ownerOf = (file: string): number | undefined => {
  const n = Number(readFileSync(file, 'utf8').trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/** A slot is stale when its owner died, or when it names no owner and has aged past the grace period. */
function stale(file: string): boolean {
  const owner = ownerOf(file);
  if (owner !== undefined) return !alive(owner);
  return Date.now() - statSync(file).mtimeMs > UNOWNED_GRACE_MS;
}

function tryTake(dir: string, cap: number): string | undefined {
  // The slot appears with its owner pid already inside (hard link of a written file), so no reader ever sees it empty.
  const mine = join(
    dir,
    `.take-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  writeFileSync(mine, String(process.pid));
  try {
    for (let i = 0; i < cap; i++) {
      const file = join(dir, `slot-${i}`);
      try {
        linkSync(mine, file);
        return file;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      try {
        if (!stale(file)) continue;
      } catch {
        // Released while we looked: retry this slot.
        i--;
        continue;
      }
      // One reclaimer wins the rename; the others see the slot missing and retry. A slot taken afresh between our
      // look and the rename goes back to its new owner.
      const moved = `${file}.stale-${process.pid}`;
      try {
        renameSync(file, moved);
      } catch {
        i--;
        continue;
      }
      try {
        if (!stale(moved)) linkSync(moved, file);
      } catch {
        // The slot was taken again meanwhile; the moved file is no one's slot now.
      }
      rmSync(moved, { force: true });
      i--;
    }
    return undefined;
  } finally {
    rmSync(mine, { force: true });
  }
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
