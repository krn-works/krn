import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { setTimeout as poll } from 'node:timers/promises';
import { SPAWNED_PROCESS_WAIT_MS } from '../support/process-wait.ts';

export const CONDITION_WAIT_MS = Math.max(120_000, SPAWNED_PROCESS_WAIT_MS);

export function conditionTimeoutFor(waits: number): number {
  return (waits + 2) * CONDITION_WAIT_MS;
}

// Undefined means "not observed yet"; false and zero can be observed results.
export async function waitForCondition<T>(
  read: () => T | undefined | Promise<T | undefined>,
  condition: string,
  timeoutMs = CONDITION_WAIT_MS,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    const remaining = deadline - performance.now();
    assert.ok(remaining > 0, `Timed out waiting for ${condition}`);
    // Poll only after a failed observation, bounded by the condition's deadline.
    await poll(Math.min(25, remaining));
  }
}

export async function waitForProcessExit(
  child: ChildProcess,
  condition: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  try {
    return await waitForCondition(
      () =>
        (child.exitCode !== null || child.signalCode !== null) &&
        child.stdout?.readableEnded !== false &&
        child.stderr?.readableEnded !== false
          ? { code: child.exitCode, signal: child.signalCode }
          : undefined,
      condition,
    );
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}
