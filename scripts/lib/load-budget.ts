import { cpus, loadavg } from 'node:os';

/**
 * A test that runs real dependency installs carries a timeout sized for an idle host.
 * When the host is busier than its cores, the same work takes proportionally longer, so
 * the ceiling grows by the load per core (never below the idle size, at most `maxFactor`).
 */
export function loadScaledTimeoutMs(
  idleMs: number,
  load: number = loadavg()[0] ?? 0,
  cores: number = cpus().length,
  maxFactor = 8,
): number {
  const perCore = cores > 0 ? load / cores : 0;
  const factor = Number.isFinite(perCore)
    ? Math.min(maxFactor, Math.max(1, perCore))
    : 1;
  return Math.ceil(idleMs * factor);
}
