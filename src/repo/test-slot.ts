// The host test slot options shared by fast and the Stop hook: one lock under the shared checkout's .krn/tmp.
import { spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** The main checkout shared by every worktree, else the root itself. */
export function sharedRoot(root: string): string {
  const run = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: root,
    encoding: 'utf8',
  });
  const common = run.status === 0 ? run.stdout.trim() : '';
  return common ? dirname(resolve(root, common)) : root;
}

/** Default holders: one per eight cores, so a 16-core host runs two fast checks at once instead of serialising every lane. */
export function defaultTestSlots(
  cores: number = availableParallelism(),
): number {
  return Math.max(1, Math.floor(cores / 8));
}

/** Longest wait for a host test slot: KRN_FAST_SLOT_DEADLINE_MS, else 15 minutes (waits under load run 150-460 s). */
export function slotDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.KRN_FAST_SLOT_DEADLINE_MS);
  return Number.isFinite(value) && value > 0 ? value : 900_000;
}

/** Slot lock options: one lock under the shared checkout's .krn/tmp, KRN_FAST_SLOTS holders at once. */
export function testSlotOptions(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  cores: number = availableParallelism(),
): { dir: string; slots: number; deadlineMs: number } {
  const slots = Number(env.KRN_FAST_SLOTS);
  return {
    deadlineMs: slotDeadlineMs(env),
    dir: env.KRN_FAST_SLOT_DIR ?? join(sharedRoot(root), '.krn/tmp/fast-slots'),
    slots:
      Number.isInteger(slots) && slots > 0 ? slots : defaultTestSlots(cores),
  };
}

/** Set in the environment of a test run that already holds a slot, so a nested Stop check runs inside it instead of queueing again. */
export const SLOT_HELD_ENV = 'KRN_TEST_SLOT_HELD';
