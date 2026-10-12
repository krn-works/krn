import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire, registerHooks } from 'node:module';
import type { TestContext } from 'node:test';
import {
  decideIsolation,
  type IsolationCapabilities,
  type IsolationCapability,
} from '../../scripts/isolation-gate.mjs';

const runnerState = (() => {
  const rawCapabilities = process.env.KRN_ISOLATION_CAPABILITIES;
  if (!rawCapabilities) return { kind: 'missing' } as const;
  try {
    return {
      kind: 'ready',
      capabilities: JSON.parse(rawCapabilities) as IsolationCapabilities,
      isCI: process.env.CI === 'true',
    } as const;
  } catch {
    return { kind: 'invalid' } as const;
  }
})();

type TestCallback = (...args: unknown[]) => unknown;
type TestRegistration = (...args: unknown[]) => unknown;
type TestApi = { test: TestRegistration; it: TestRegistration };
type ContextState = {
  active: boolean;
  authorizingSkip: boolean;
  approvedSkipCount: number;
};

const activeTestContext = new AsyncLocalStorage<TestContext>();
const contextStates = new WeakMap<TestContext, ContextState>();
const guardedPrototypes = new WeakSet<object>();
const writeRunnerOutput = process.stdout.write.bind(process.stdout);
const registrationWrappers = new WeakMap<TestRegistration, TestRegistration>();
const testFileUrl = /(?:^|\/)[^/]+\.test\.(?:ts|js|mjs|cjs)(?:[?#]|$)/u;

export function wrapTestRegistration(
  original: TestRegistration,
): TestRegistration {
  const existing = registrationWrappers.get(original);
  if (existing) return existing;

  const wrapped: TestRegistration = function (
    this: unknown,
    ...args: unknown[]
  ): unknown {
    const callbackIndex = typeof args[1] === 'function' ? 1 : 2;
    const callback = args[callbackIndex];
    if (typeof callback === 'function')
      args[callbackIndex] = wrapCallback(callback as TestCallback);
    return Reflect.apply(original, this, args);
  };

  registrationWrappers.set(original, wrapped);
  for (const key of Reflect.ownKeys(original)) {
    const descriptor = Object.getOwnPropertyDescriptor(original, key);
    if (!descriptor) continue;
    if ('value' in descriptor && typeof descriptor.value === 'function') {
      const registration = descriptor.value as TestRegistration;
      if (registration === original) descriptor.value = wrapped;
      else if (
        ['test', 'it', 'suite', 'describe', 'only', 'skip', 'todo'].includes(
          String(key),
        )
      )
        descriptor.value = wrapTestRegistration(registration);
    }
    Object.defineProperty(wrapped, key, descriptor);
  }
  Object.setPrototypeOf(wrapped, Object.getPrototypeOf(original));
  return wrapped;
}

const testApi = createRequire(import.meta.url)('node:test') as TestApi;
testApi.test = wrapTestRegistration(testApi.test);
testApi.it = wrapTestRegistration(testApi.it);

const testApiModuleSource = [
  "import * as nodeTest from 'node:test';",
  `import { wrapTestRegistration } from ${JSON.stringify(import.meta.url)};`,
  "export * from 'node:test';",
  'export const test = wrapTestRegistration(nodeTest.test);',
  'export const it = wrapTestRegistration(nodeTest.it);',
  'export default test;',
].join('\n');
const testApiModuleUrl = `data:text/javascript,${encodeURIComponent(testApiModuleSource)}`;

// ESM test imports cannot be replaced by mutating the CommonJS node:test export.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === 'node:test' &&
      context.conditions.includes('import') &&
      context.parentURL &&
      testFileUrl.test(context.parentURL)
    )
      return { url: testApiModuleUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

function wrapCallback(callback: TestCallback): TestCallback {
  return function (this: unknown, ...args: unknown[]): unknown {
    const context = args[0] as TestContext | undefined;
    if (!context || typeof context !== 'object')
      return Reflect.apply(callback, this, args);

    const state: ContextState = {
      active: true,
      authorizingSkip: false,
      approvedSkipCount: 0,
    };
    contextStates.set(context, state);
    guardContextPrototype(context);

    let result: unknown;
    try {
      result = activeTestContext.run(context, () =>
        Reflect.apply(callback, this, args),
      );
    } catch (error) {
      state.active = false;
      throw error;
    }
    if (result && typeof (result as { then?: unknown }).then === 'function')
      return Promise.resolve(result).finally(() => {
        state.active = false;
      });
    state.active = false;
    return result;
  };
}

function guardContextPrototype(context: TestContext): void {
  const prototype = Object.getPrototypeOf(context) as Record<
    string,
    unknown
  > | null;
  if (!prototype || guardedPrototypes.has(prototype)) return;

  const skipDescriptor = Object.getOwnPropertyDescriptor(prototype, 'skip');
  if (typeof skipDescriptor?.value !== 'function') return;
  const originalSkip = skipDescriptor.value as TestRegistration;
  Object.defineProperty(prototype, 'skip', {
    ...skipDescriptor,
    value: function (this: TestContext, ...args: unknown[]): unknown {
      const state = contextStates.get(this);
      if (
        !state?.active ||
        !state.authorizingSkip ||
        state.approvedSkipCount > 0 ||
        activeTestContext.getStore() !== this
      ) {
        writeRunnerOutput(`UNAPPROVED_TEST_SKIP: ${this.name}\n`);
      } else {
        state.approvedSkipCount += 1;
      }
      return Reflect.apply(originalSkip, this, args);
    },
  });

  for (const method of ['test', 'it'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
    if (typeof descriptor?.value !== 'function') continue;
    Object.defineProperty(prototype, method, {
      ...descriptor,
      value: wrapTestRegistration(descriptor.value as TestRegistration),
    });
  }
  guardedPrototypes.add(prototype);
}

export function requiresIsolation(
  context: TestContext,
  testName: string,
  required: readonly IsolationCapability[],
): boolean {
  assert.notEqual(
    runnerState.kind,
    'missing',
    'isolation capability probe did not run',
  );
  assert.notEqual(
    runnerState.kind,
    'invalid',
    'isolation capability probe returned invalid JSON',
  );
  if (runnerState.kind !== 'ready') return false;
  assert.equal(
    activeTestContext.getStore(),
    context,
    'requiresIsolation must receive the active test context',
  );
  const state = contextStates.get(context);
  assert.ok(
    state?.active,
    'requiresIsolation must receive the active test context',
  );
  const decision = decideIsolation(
    testName,
    required,
    runnerState.capabilities,
    runnerState.isCI,
  );
  if (decision.kind === 'run') return true;
  if (decision.kind === 'fail') assert.fail(decision.message);
  writeRunnerOutput(`${decision.line}\n`);
  state.authorizingSkip = true;
  try {
    context.skip('isolation capability unavailable');
  } finally {
    state.authorizingSkip = false;
  }
  return false;
}
