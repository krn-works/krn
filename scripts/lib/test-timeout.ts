// One timeout ceiling for every node --test run (npm test, CI shards, npm run fast),
// so a test that never settles fails by name instead of hanging its job.
import { availableParallelism, cpus, loadavg } from 'node:os';

export const testTimeoutMs = 60_000;

/**
 * node --test flags for the ceiling. --test-force-exit ends a file once its tests
 * finish, so a timed-out test's live handle cannot keep the file running.
 * KRN_TEST_TIMEOUT_MS lowers the ceiling for the runners' own tests. The
 * force exit would cut a file's last events off the stdout pipe, so every
 * runner preloads test-exit-flush.mjs, which drains the pipe before exiting.
 */
export const testExitFlushPreload = new URL(
  './test-exit-flush.mjs',
  import.meta.url,
).href;

export interface HostCapacity {
  /** The 1-minute load average. */
  load?: number;
  cores?: number;
  parallelism?: number;
}

/**
 * The node --test file concurrency: node's own default (availableParallelism() - 1) on an idle
 * host, fewer when other work already holds the cores, never below 2. A loaded host runs the
 * check slower instead of timing it out.
 */
export function testConcurrency(host: HostCapacity = {}): number {
  const cores = host.cores ?? cpus().length;
  const parallelism = host.parallelism ?? availableParallelism();
  const load = host.load ?? loadavg()[0] ?? 0;
  return Math.max(2, Math.min(parallelism - 1, cores - Math.round(load)));
}

export function testCeilingArguments(
  env: NodeJS.ProcessEnv = process.env,
  host: HostCapacity = {},
): string[] {
  const override = Number(env.KRN_TEST_TIMEOUT_MS);
  const ms =
    Number.isInteger(override) && override > 0 ? override : testTimeoutMs;
  return [
    `--test-timeout=${ms}`,
    `--test-concurrency=${testConcurrency(host)}`,
    '--test-force-exit',
    `--import=${testExitFlushPreload}`,
  ];
}
