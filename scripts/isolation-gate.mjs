import { AsyncLocalStorage } from 'node:async_hooks';
import { registerHooks } from 'node:module';

const capabilityNames = ['bwrap', 'systemdUserScope'];
const approvalMarkerPrefix = ' [KRN-ISOLATION-APPROVAL:';
const testApiKey = 'krn.isolation-gate.test-api';
const activeTest = new AsyncLocalStorage();
const contextStates = new WeakMap();
const guardedPrototypes = new WeakMap();

let runnerState;

export function decideIsolation(testName, required, capabilities, isCI) {
  const labels = {
    bwrap: 'bwrap user namespaces',
    systemdUserScope: 'systemd user scopes',
  };
  const missing = required.filter((name) => !capabilities[name]?.available);
  if (missing.length === 0) return { kind: 'run' };

  const list = missing.map((name) => labels[name]).join(', ');
  if (isCI)
    return {
      kind: 'skip',
      line: `SKIP(isolation): ${testName} — missing ${list}`,
    };
  return {
    kind: 'fail',
    message: `Isolation requirements failed for ${testName}: missing ${list}`,
  };
}

export function isolationSummary(skipCount) {
  return `Isolation-dependent tests skipped: ${skipCount}`;
}

export function countIsolationSkips(output, runnerToken) {
  if (!/^[a-f0-9]{64}$/u.test(runnerToken ?? '')) return 0;
  const marker = `${approvalMarkerPrefix}${runnerToken}:`;
  return output.split(marker).length - 1;
}

export function testSuiteExitCode(exitCode, skipCount, requireZeroSkips) {
  if (exitCode !== 0) return exitCode || 1;
  return requireZeroSkips && skipCount > 0 ? 1 : 0;
}

export function testSuiteSummaryIsValid({
  selectedTestCount,
  skippedTestCount,
  todoCount,
  approvedSkipCount,
}) {
  return (
    selectedTestCount > 0 &&
    todoCount === 0 &&
    skippedTestCount === approvedSkipCount
  );
}

export async function postGateStatusWhenClean({ exitCode, skipCount, post }) {
  if (exitCode !== 0 || skipCount !== 0) return false;
  await post();
  return true;
}

export function requiresIsolation(context, testName, required) {
  const state = runnerState;
  const active = activeTest.getStore();
  const contextState = contextStates.get(context);
  if (
    !state ||
    !active ||
    active !== contextState ||
    active.context !== context ||
    !active.active ||
    !active.allowIsolation
  )
    throw new Error(
      'requiresIsolation must be called with the active TestContext inside a registered test callback',
    );

  if (typeof testName !== 'string' || !Array.isArray(required))
    throw new Error('requiresIsolation received invalid test metadata');
  for (const name of required) {
    if (!capabilityNames.includes(name))
      throw new Error(`requiresIsolation received unknown capability: ${name}`);
  }

  const decision = decideIsolation(
    testName,
    required,
    state.capabilities,
    state.isCI,
  );
  if (decision.kind === 'run') return true;
  if (decision.kind === 'fail') throw new Error(decision.message);

  state.sequence += 1;
  const reason = `${decision.line}${approvalMarkerPrefix}${state.token}:${state.sequence}]`;
  active.approvedReason = reason;
  try {
    context.skip(reason);
  } finally {
    active.approvedReason = undefined;
  }
  return false;
}

function parseCapabilities(raw) {
  if (typeof raw !== 'string' || raw.length === 0)
    throw new Error('isolation capability probe did not run');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('isolation capability probe returned invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('isolation capability probe returned invalid data');

  const snapshot = {};
  for (const name of capabilityNames) {
    const capability = parsed[name];
    if (!capability || typeof capability.available !== 'boolean')
      throw new Error(`isolation capability probe omitted ${name}`);
    if (
      capability.reason !== undefined &&
      typeof capability.reason !== 'string'
    )
      throw new Error(
        `isolation capability probe returned invalid ${name} reason`,
      );
    snapshot[name] = Object.freeze({
      available: capability.available,
      ...(capability.reason === undefined ? {} : { reason: capability.reason }),
    });
  }
  return Object.freeze(snapshot);
}

function activeRunnerState() {
  const token = process.env.KRN_ISOLATION_APPROVAL_TOKEN;
  if (
    process.env.NODE_TEST_CONTEXT === undefined ||
    !/^[a-f0-9]{64}$/u.test(token ?? '')
  )
    return;

  const capabilities = parseCapabilities(
    process.env.KRN_ISOLATION_CAPABILITIES,
  );
  runnerState = {
    token,
    capabilities,
    isCI: process.env.CI === 'true',
    sequence: 0,
  };

  // The parent runner needs this token for output accounting; test callbacks do not.
  delete process.env.KRN_ISOLATION_APPROVAL_TOKEN;
  installNodeTestGuards();
}

function installNodeTestGuards() {
  const nativeGetBuiltin = process.getBuiltinModule.bind(process);
  const nativeTest = nativeGetBuiltin('node:test');
  const nativeModule = nativeGetBuiltin('node:module');
  if (typeof nativeTest !== 'function' || !nativeModule)
    throw new Error('Node test registration APIs are unavailable');

  const wrappedTest = wrapRegistration(nativeTest, true);
  const wrappedIt = wrapRegistration(nativeTest.it, true);
  const wrappedDescribe = wrapRegistration(nativeTest.describe, false);
  const wrappedSuite = wrapRegistration(nativeTest.suite, false);
  const wrappedOnly = wrapRegistration(nativeTest.only, true);
  const wrappedBefore = wrapRegistration(nativeTest.before, false);
  const wrappedAfter = wrapRegistration(nativeTest.after, false);
  const wrappedBeforeEach = wrapRegistration(nativeTest.beforeEach, false);
  const wrappedAfterEach = wrapRegistration(nativeTest.afterEach, false);
  const rejectSkip = () => {
    throw new Error(
      'Registration-level skips are not permitted; use requiresIsolation inside a test callback',
    );
  };
  const rejectTodo = () => {
    throw new Error('Registration-level todo tests are not permitted');
  };

  const api = Object.assign(wrappedTest, {
    default: wrappedTest,
    test: wrappedTest,
    it: wrappedIt,
    describe: wrappedDescribe,
    suite: wrappedSuite,
    only: wrappedOnly,
    skip: rejectSkip,
    todo: rejectTodo,
    before: wrappedBefore,
    after: wrappedAfter,
    beforeEach: wrappedBeforeEach,
    afterEach: wrappedAfterEach,
    expectFailure: nativeTest.expectFailure,
    getTestContext: nativeTest.getTestContext,
    mock: nativeTest.mock,
    run: nativeTest.run,
    snapshot: nativeTest.snapshot,
    assert: nativeTest.assert,
  });

  // All ESM import forms resolve to guarded registration functions.
  const exportNames = [
    'after',
    'afterEach',
    'assert',
    'before',
    'beforeEach',
    'describe',
    'expectFailure',
    'getTestContext',
    'it',
    'mock',
    'only',
    'run',
    'skip',
    'snapshot',
    'suite',
    'test',
    'todo',
  ];
  const source = [
    `const api = globalThis[Symbol.for(${JSON.stringify(testApiKey)})];`,
    'export default api.default;',
    ...exportNames.map(
      (name) => `export const ${name} = api[${JSON.stringify(name)}];`,
    ),
  ].join('\n');
  globalThis[Symbol.for(testApiKey)] = api;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'node:test' || specifier === 'test')
        return { url: 'krn-internal:guarded-node-test', shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === 'krn-internal:guarded-node-test')
        return { format: 'module', shortCircuit: true, source };
      return nextLoad(url, context);
    },
  });

  // CommonJS uses the callable module export; the ESM hooks above provide its twin.
  const originalLoad = nativeModule._load;
  nativeModule._load = function (request, parent, isMain) {
    if (request === 'node:test' || request === 'test') return api;
    return Reflect.apply(originalLoad, this, [request, parent, isMain]);
  };
  Object.defineProperty(process, 'getBuiltinModule', {
    value(id) {
      if (id === 'node:test' || id === 'test') return api;
      return Reflect.apply(nativeGetBuiltin, process, [id]);
    },
    configurable: false,
    writable: false,
  });
}

function wrapRegistration(registration, allowIsolation) {
  if (typeof registration !== 'function') return registration;
  const callable = () => {};
  return new Proxy(callable, {
    apply(_target, thisArg, args) {
      for (const argument of args) {
        if (!argument || typeof argument !== 'object') continue;
        if (
          ('skip' in argument && argument.skip) ||
          ('todo' in argument && argument.todo)
        )
          throw new Error(
            'Registration-level skips and todos are not permitted; use requiresIsolation inside a test callback',
          );
      }

      const callbackIndex = args.findLastIndex(
        (argument) => typeof argument === 'function',
      );
      if (callbackIndex >= 0)
        args[callbackIndex] = wrapCallback(args[callbackIndex], allowIsolation);
      return Reflect.apply(registration, thisArg, args);
    },
    get(target, property, receiver) {
      if (property === 'skip')
        return () => {
          throw new Error(
            'Registration-level skips are not permitted; use requiresIsolation inside a test callback',
          );
        };
      if (property === 'todo')
        return () => {
          throw new Error('Registration-level todo tests are not permitted');
        };
      if (Reflect.has(target, property))
        return Reflect.get(target, property, receiver);
      return Reflect.get(registration, property, registration);
    },
  });
}

function wrapCallback(callback, allowIsolation) {
  return function (...args) {
    const context = args[0];
    const state = {
      context,
      active: true,
      allowIsolation,
      approvedReason: undefined,
      skipUsed: false,
    };
    if (context && typeof context === 'object') {
      contextStates.set(context, state);
      guardContext(context);
    }

    let result;
    try {
      result = activeTest.run(state, () => Reflect.apply(callback, this, args));
      if (result && typeof result.then === 'function')
        return Promise.resolve(result).finally(() => {
          state.active = false;
        });
      state.active = false;
      return result;
    } catch (error) {
      state.active = false;
      throw error;
    }
  };
}

function guardContext(context) {
  const prototype = Object.getPrototypeOf(context);
  if (!prototype)
    throw new Error('test callback did not receive a TestContext');
  let guards = guardedPrototypes.get(prototype);
  if (!guards) {
    const skipDescriptor = Object.getOwnPropertyDescriptor(prototype, 'skip');
    const todoDescriptor = Object.getOwnPropertyDescriptor(prototype, 'todo');
    if (
      !skipDescriptor ||
      typeof skipDescriptor.value !== 'function' ||
      !todoDescriptor ||
      typeof todoDescriptor.value !== 'function'
    )
      throw new Error('Node TestContext skip methods could not be guarded');

    const originalSkip = skipDescriptor.value;
    const skipGuard = function (...args) {
      const state = contextStates.get(this);
      if (
        !state?.active ||
        activeTest.getStore() !== state ||
        !state.allowIsolation ||
        state.skipUsed ||
        state.approvedReason === undefined ||
        args.length !== 1 ||
        args[0] !== state.approvedReason
      )
        throw new Error(
          'TestContext.skip is only permitted after requiresIsolation approves an active test context',
        );
      state.skipUsed = true;
      state.approvedReason = undefined;
      return Reflect.apply(originalSkip, this, args);
    };
    const todoGuard = () => {
      throw new Error(
        'TestContext.todo is not permitted by the isolation gate',
      );
    };
    Object.defineProperty(prototype, 'skip', {
      ...skipDescriptor,
      value: skipGuard,
      writable: false,
      configurable: false,
    });
    Object.defineProperty(prototype, 'todo', {
      ...todoDescriptor,
      value: todoGuard,
      writable: false,
      configurable: false,
    });
    guards = { skip: skipGuard, todo: todoGuard };
    guardedPrototypes.set(prototype, guards);
  }

  Object.defineProperty(context, 'skip', {
    value: guards.skip,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  Object.defineProperty(context, 'todo', {
    value: guards.todo,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

activeRunnerState();
