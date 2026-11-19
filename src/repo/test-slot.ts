// The host test slot options shared by fast and the Stop hook: KRN's heavy checks are clients of the host-wide gate.
import { availableParallelism } from 'node:os';
import {
  gateLimits,
  hostGateDir,
  hostPressure,
  hostUnits,
  SLOT_HELD_ENV,
  sampleHost,
} from './host-gate.ts';
import type { SlotOptions } from './slot-lock.ts';

export { SLOT_HELD_ENV };

/** Concurrent fast checks on an idle host: one per eight cores, so a 16-core host runs two at once. */
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

/**
 * Gate options for a fast check or Stop check. By default it takes a weight of the host gate sized so
 * defaultTestSlots checks fit an idle host, and waits while load or memory is short. KRN_FAST_SLOTS
 * counts holders of weight 1 instead; KRN_FAST_SLOT_DIR moves the lock and turns the host probe off (tests).
 */
export function testSlotOptions(
  _root: string,
  env: NodeJS.ProcessEnv = process.env,
  cores: number = availableParallelism(),
): SlotOptions & { dir: string; slots: number; weight: number } {
  const deadlineMs = slotDeadlineMs(env);
  const dir = env.KRN_FAST_SLOT_DIR ?? hostGateDir(env);
  const pressure = env.KRN_FAST_SLOT_DIR
    ? undefined
    : () => hostPressure(sampleHost(), gateLimits(env));
  const count = Number(env.KRN_FAST_SLOTS);
  if (Number.isInteger(count) && count > 0)
    return { deadlineMs, dir, pressure, slots: count, weight: 1 };
  const slots = hostUnits(env, cores);
  return {
    deadlineMs,
    dir,
    pressure,
    slots,
    weight: Math.max(1, Math.ceil(slots / defaultTestSlots(cores))),
  };
}
