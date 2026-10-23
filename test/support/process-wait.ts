import { TRACE_LOCK_WAIT_MS } from '../../src/trace/lock-wait.ts';

const configuredWaitMs = process.env.KRN_TEST_PROCESS_WAIT_MS;

export const SPAWNED_PROCESS_WAIT_MS =
  configuredWaitMs === undefined
    ? TRACE_LOCK_WAIT_MS
    : Number(configuredWaitMs);

if (
  !Number.isSafeInteger(SPAWNED_PROCESS_WAIT_MS) ||
  SPAWNED_PROCESS_WAIT_MS <= 0
)
  throw new Error('KRN_TEST_PROCESS_WAIT_MS must be a positive safe integer');

export function testTimeoutFor(sharedWaitCount: number): number {
  if (!Number.isSafeInteger(sharedWaitCount) || sharedWaitCount < 0)
    throw new Error('sharedWaitCount must be a non-negative safe integer');

  // Leave two more wait intervals for setup, assertions, and cleanup.
  return (sharedWaitCount + 2) * SPAWNED_PROCESS_WAIT_MS;
}
