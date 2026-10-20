import type { TestContext } from 'node:test';
import type { IsolationCapability } from '../../scripts/isolation-gate.mjs';

type RunnerApi = {
  requiresIsolation: (
    context: TestContext,
    testName: string,
    required: readonly IsolationCapability[],
  ) => boolean;
};

function isRunnerApi(value: unknown): value is RunnerApi {
  return (
    typeof value === 'object' &&
    value !== null &&
    'requiresIsolation' in value &&
    typeof value.requiresIsolation === 'function'
  );
}

function getRunnerApi(value: unknown): RunnerApi {
  if (!isRunnerApi(value))
    throw new Error('test-suite isolation approval preloader did not run');
  return value;
}

const runnerApi = getRunnerApi(
  Reflect.get(globalThis, Symbol.for('krn.isolation-gate.runtime-api')),
);

export function requiresIsolation(
  context: TestContext,
  testName: string,
  required: readonly IsolationCapability[],
): boolean {
  return runnerApi.requiresIsolation(context, testName, required);
}
