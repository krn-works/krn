import type { TestContext } from 'node:test';
import * as isolationGate from '../../scripts/isolation-gate.mjs';

const runnerRequiresIsolation = (
  isolationGate as unknown as {
    requiresIsolation: (
      context: TestContext,
      testName: string,
      required: readonly IsolationCapability[],
    ) => boolean;
  }
).requiresIsolation;

export type IsolationCapability = 'bwrap' | 'systemdUserScope';

export function requiresIsolation(
  context: TestContext,
  testName: string,
  required: readonly IsolationCapability[],
): boolean {
  return runnerRequiresIsolation(context, testName, required);
}
