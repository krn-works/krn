// The registry of named metrics (`spec/metrics.json`). A `Predicted: metric <name> <op> N` line is judged
// by running the metric's command, which prints one number, in the repository root.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const METRICS_FILE = 'spec/metrics.json';

/** Names the metric whose command is running, so a command that calls `krn ledger --predictions` never scores itself. */
export const METRIC_RUN_ENV = 'KRN_METRIC_RUN';

const METRIC_TIMEOUT_MS = 30_000;

export type MetricRegistry = Record<string, { command: string }>;

/** The registered metrics, or an empty registry when the file is missing or unreadable. */
export function readMetricRegistry(root: string): MetricRegistry {
  const path = join(root, METRICS_FILE);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      metrics?: Record<string, { command?: unknown }>;
    };
    const registry: MetricRegistry = {};
    for (const [name, entry] of Object.entries(parsed.metrics ?? {}))
      if (typeof entry?.command === 'string' && entry.command !== '')
        registry[name] = { command: entry.command };
    return registry;
  } catch {
    return {};
  }
}

/** The one number a command prints, or undefined when it fails, times out or prints anything else. */
export function runMetricCommand(
  name: string,
  command: string,
  root: string,
): number | undefined {
  try {
    const out = execFileSync('sh', ['-c', command], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: METRIC_TIMEOUT_MS,
      env: { ...process.env, [METRIC_RUN_ENV]: name },
    }).trim();
    return /^-?\d+(?:\.\d+)?$/u.test(out) ? Number(out) : undefined;
  } catch {
    return undefined;
  }
}

/** The reader a scorecard uses: a metric's current value, undefined while it is unregistered or does not run. */
export function metricReader(
  root: string,
): (name: string) => number | undefined {
  const registry = readMetricRegistry(root);
  const cache = new Map<string, number | undefined>();
  return (name) => {
    if (process.env[METRIC_RUN_ENV] === name) return undefined;
    const entry = registry[name];
    if (entry === undefined) return undefined;
    if (!cache.has(name))
      cache.set(name, runMetricCommand(name, entry.command, root));
    return cache.get(name);
  };
}
