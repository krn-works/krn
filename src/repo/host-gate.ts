// The host-wide heavy-job gate: one slot directory outside every checkout, sized by cores and held back by load and memory.
import { readFileSync } from 'node:fs';
import { availableParallelism, freemem, homedir, loadavg } from 'node:os';
import { join } from 'node:path';

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

/** Why the host has no room for another heavy job, or undefined when it has. */
export function hostPressure(
  sample: HostSample,
  limits: GateLimits = gateLimits(),
): string | undefined {
  const ceiling = sample.cores * limits.loadPerCore;
  if (sample.load1 >= ceiling)
    return `load ${sample.load1.toFixed(1)} >= ${ceiling.toFixed(1)}`;
  if (sample.availableMb < limits.minAvailableMb)
    return `available memory ${sample.availableMb} MB < ${limits.minAvailableMb} MB`;
  return undefined;
}

/** Set in the environment of a job that holds a gate slot, so a nested heavy command runs inside it instead of queueing again. */
export const SLOT_HELD_ENV = 'KRN_TEST_SLOT_HELD';
