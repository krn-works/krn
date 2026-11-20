// The host-wide heavy-job gate: one slot directory outside every checkout, sized by cores and held back by load and memory.
import { readFileSync } from 'node:fs';
import { availableParallelism, freemem, homedir, loadavg } from 'node:os';
import { join } from 'node:path';
import type { Admission } from './slot-lock.ts';

/** Directory every project's heavy jobs share: KRN_HEAVY_GATE_DIR, else $XDG_STATE_HOME/krn/heavy-gate. */
export function hostGateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KRN_HEAVY_GATE_DIR) return env.KRN_HEAVY_GATE_DIR;
  const state = env.XDG_STATE_HOME || join(homedir(), '.local/state');
  return join(state, 'krn/heavy-gate');
}

/** Gate capacity in weight units: KRN_HEAVY_GATE_UNITS, else one unit per hardware thread. */
export function hostUnits(
  env: NodeJS.ProcessEnv = process.env,
  cores: number = availableParallelism(),
): number {
  const units = Number(env.KRN_HEAVY_GATE_UNITS);
  return Number.isInteger(units) && units > 0 ? units : Math.max(1, cores);
}

export type HostSample = { load1: number; availableMb: number; cores: number };

/** MemAvailable from /proc/meminfo in MB, else the free memory Node reports. */
function availableMb(): number {
  try {
    const line = /^MemAvailable:\s+(\d+) kB/m.exec(
      readFileSync('/proc/meminfo', 'utf8'),
    );
    if (line) return Math.round(Number(line[1]) / 1024);
  } catch {
    // No /proc (macOS): fall through to Node's figure.
  }
  return Math.round(freemem() / 1024 / 1024);
}

export function sampleHost(): HostSample {
  return {
    availableMb: availableMb(),
    cores: availableParallelism(),
    load1: loadavg()[0] ?? 0,
  };
}

/** Thresholds a new heavy job waits on: load per core (KRN_HEAVY_GATE_LOAD_PER_CORE, default 1.25) and available MB (KRN_HEAVY_GATE_MIN_MB, default 2048). */
export type GateLimits = { loadPerCore: number; minAvailableMb: number };

export function gateLimits(env: NodeJS.ProcessEnv = process.env): GateLimits {
  const load = Number(env.KRN_HEAVY_GATE_LOAD_PER_CORE);
  const memory = Number(env.KRN_HEAVY_GATE_MIN_MB);
  return {
    loadPerCore: Number.isFinite(load) && load > 0 ? load : 1.25,
    minAvailableMb:
      env.KRN_HEAVY_GATE_MIN_MB !== undefined &&
      Number.isFinite(memory) &&
      memory >= 0
        ? memory
        : 2048,
  };
}

/** Time constant of the kernel's one-minute load average. */
const LOAD1_TAU_MS = 60_000;

/**
 * Load the host will carry once admitted jobs show up in load1, which lags by about a minute:
 * each holder adds the part of its weight load1 has not caught up with yet, and the job asking in adds its whole weight.
 */
export function projectedLoad(load1: number, admission?: Admission): number {
  if (admission === undefined) return load1;
  let pending = admission.weight;
  for (const slot of admission.held)
    pending += slot.weight * Math.exp(-slot.ageMs / LOAD1_TAU_MS);
  return load1 + pending;
}

/** Why the host has no room for another heavy job, or undefined when it has; with an admission, the load is projected over the holders and the job asking in. */
export function hostPressure(
  sample: HostSample,
  limits: GateLimits = gateLimits(),
  admission?: Admission,
): string | undefined {
  const ceiling = sample.cores * limits.loadPerCore;
  const load = projectedLoad(sample.load1, admission);
  if (admission === undefined ? load >= ceiling : load > ceiling)
    return admission === undefined
      ? `load ${sample.load1.toFixed(1)} >= ${ceiling.toFixed(1)}`
      : `projected load ${load.toFixed(1)} (load1 ${sample.load1.toFixed(1)} + admitted jobs) > ${ceiling.toFixed(1)}`;
  if (sample.availableMb < limits.minAvailableMb)
    return `available memory ${sample.availableMb} MB < ${limits.minAvailableMb} MB`;
  return undefined;
}

/** Set in the environment of a job that holds a gate slot, so a nested heavy command runs inside it instead of queueing again. */
export const SLOT_HELD_ENV = 'KRN_TEST_SLOT_HELD';

/** What a new lane is admitted on: the host sample plus the heavy-gate units held out of its capacity. */
export type HostCapacity = {
  sample: HostSample;
  usedUnits: number;
  capacity: number;
};

/** Lane admission thresholds: KRN_LANE_LOAD_PER_CORE and KRN_LANE_MIN_MB, defaulting to the heavy-gate values. */
export function laneLimits(env: NodeJS.ProcessEnv = process.env): GateLimits {
  return gateLimits({
    KRN_HEAVY_GATE_LOAD_PER_CORE:
      env.KRN_LANE_LOAD_PER_CORE ?? env.KRN_HEAVY_GATE_LOAD_PER_CORE,
    KRN_HEAVY_GATE_MIN_MB: env.KRN_LANE_MIN_MB ?? env.KRN_HEAVY_GATE_MIN_MB,
  });
}

/** Why the host has no room for another lane (load, memory or a full heavy-job gate), naming the numbers; undefined when it has. */
export function laneHostShortfall(
  host: HostCapacity,
  limits: GateLimits,
): string | undefined {
  const pressure = hostPressure(host.sample, limits);
  const full =
    host.usedUnits >= host.capacity
      ? `heavy-job gate full ${host.usedUnits}/${host.capacity} units`
      : undefined;
  const reason = pressure ?? full;
  if (reason === undefined) return undefined;
  return `${reason} (load ${host.sample.load1.toFixed(1)} on ${host.sample.cores} cores, ${host.sample.availableMb} MB available, gate ${host.usedUnits}/${host.capacity} units; limits ${limits.loadPerCore}/core and ${limits.minAvailableMb} MB, KRN_LANE_LOAD_PER_CORE, KRN_LANE_MIN_MB)`;
}
