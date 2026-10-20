import { AsyncLocalStorage } from 'node:async_hooks';
import { registerHooks } from 'node:module';

const capabilityNames = ['bwrap', 'systemdUserScope'];
const testApiKey = 'krn.isolation-gate.test-api';
const runtimeApiKey = 'krn.isolation-gate.runtime-api';
const activeTest = new AsyncLocalStorage();
const contextStates = new WeakMap();
const guardedPrototypes = new WeakMap();
const registrationWrappers = new WeakMap();
const registrationKinds = new Map([
  ['test', true],
  ['it', true],
  ['describe', false],
  ['suite', false],
  ['before', false],
  ['after', false],
  ['beforeEach', false],
  ['afterEach', false],
]);

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

export function countIsolationSkips(output) {
  return (output.match(/SKIP\(isolation\):/gu) ?? []).length;
}

export function testSuiteExitCode(exitCode, skipCount, requireZeroSkips) {
  if (exitCode !== 0) return exitCode || 1;
  return requireZeroSkips && skipCount > 0 ? 1 : 0;
}

export async function postGateStatusWhenClean({ exitCode, skipCount, post }) {
  if (exitCode !== 0 || skipCount !== 0) return false;
  await post();
  return true;
}

function requiresIsolation(context, testName, required) {
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
  // Caller iterators, filters and indexed accessors must not supply different
  // values to validation and the decision. Read own data descriptors once and
  // decide only from the private snapshot of those exact validated values.
  const descriptors = Object.getOwnPropertyDescriptors(required);
  const snapshot = [];
  for (let index = 0; index < descriptors.length.value; index++) {
    const descriptor = descriptors[index];
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string'
    )
      throw new Error('requiresIsolation received invalid test metadata');
    const name = descriptor.value;
    if (!capabilityNames.includes(name))
      throw new Error(`requiresIsolation received unknown capability: ${name}`);
    snapshot.push(name);
  }

  const decision = decideIsolation(
    testName,
    Object.freeze(snapshot),
    state.capabilities,
    state.isCI,
  );
  if (decision.kind === 'run') return true;
  if (decision.kind === 'fail') throw new Error(decision.message);

  const reason = decision.line;
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

function installRunnerApi() {
  Object.defineProperty(globalThis, Symbol.for(runtimeApiKey), {
    value: Object.freeze({ requiresIsolation }),
    configurable: false,
    writable: false,
  });
}

function installNodeTestGuards() {
  const nativeGetBuiltin = process.getBuiltinModule.bind(process);
  const nativeTest = nativeGetBuiltin('node:test');
  const nativeModule = nativeGetBuiltin('node:module');
  if (typeof nativeTest !== 'function' || !nativeModule)
    throw new Error('Node test registration APIs are unavailable');

  // run starts a separate runner whose events and contexts this gate cannot
  // account for. Refuse that function everywhere the public alias graph exposes
  // it; getTestContext remains the native context reader. This is an API boundary,
  // not confinement of arbitrary child-process execution by test code.
  registrationWrappers.set(nativeTest.run, () => {
    throw new Error('node:test.run is not permitted by the isolation gate');
  });
  const api = wrapRegistration(nativeTest, true);
  Object.defineProperty(api, 'default', {
    value: api,
    enumerable: true,
  });

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
  Object.freeze(api);
  Object.defineProperty(globalThis, Symbol.for(testApiKey), {
    value: api,
    configurable: false,
    writable: false,
  });
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

  const originalLoad = nativeModule._load;
  Object.defineProperty(nativeModule, '_load', {
    value: function (request, parent, isMain) {
      if (request === 'node:test' || request === 'test') return api;
      return Reflect.apply(originalLoad, this, [request, parent, isMain]);
    },
    configurable: false,
    writable: false,
  });
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
  const existing = registrationWrappers.get(registration);
  if (existing) return existing;
  const callable = () => {};
  const rejectSkip = () => {
    throw new Error(
      'Registration-level skips are not permitted; use requiresIsolation inside a test callback',
    );
  };
  const rejectTodo = () => {
    throw new Error('Registration-level todo tests are not permitted');
  };
  const wrapped = new Proxy(callable, {
    apply(_target, thisArg, args) {
      const safeArgs = args.map((argument) => {
        if (!argument || typeof argument !== 'object') return argument;
        if (
          (Reflect.has(argument, 'skip') && !Object.hasOwn(argument, 'skip')) ||
          (Reflect.has(argument, 'todo') && !Object.hasOwn(argument, 'todo'))
        )
          throw new Error(
            'Registration-level skips and todos are not permitted; use requiresIsolation inside a test callback',
          );

        const descriptors = Object.getOwnPropertyDescriptors(argument);
        const safeArgument = Object.create(null);
        for (const key of Reflect.ownKeys(descriptors)) {
          const descriptor = descriptors[key];
          if (
            (key === 'skip' || key === 'todo') &&
            (!Object.hasOwn(descriptor, 'value') || descriptor.value)
          )
            throw new Error(
              'Registration-level skips and todos are not permitted; use requiresIsolation inside a test callback',
            );
          Object.defineProperty(safeArgument, key, descriptor);
        }
        return safeArgument;
      });

      const callbackIndex = safeArgs.findLastIndex(
        (argument) => typeof argument === 'function',
      );
      if (callbackIndex >= 0)
        safeArgs[callbackIndex] = wrapCallback(
          safeArgs[callbackIndex],
          allowIsolation,
        );
      return Reflect.apply(registration, thisArg, safeArgs);
    },
  });
  // Cache before traversing: Node's test/it/test aliases form cycles. Copy the
  // guarded descriptors too, so reflection cannot recover a native registrar.
  registrationWrappers.set(registration, wrapped);
  for (const property of Reflect.ownKeys(registration)) {
    const descriptor = Object.getOwnPropertyDescriptor(registration, property);
    if (typeof descriptor.value === 'function') {
      if (property === 'skip') descriptor.value = rejectSkip;
      else if (property === 'todo') descriptor.value = rejectTodo;
      else if (property === 'only' || property === 'expectFailure')
        descriptor.value = wrapRegistration(descriptor.value, allowIsolation);
      else if (registrationWrappers.has(descriptor.value))
        descriptor.value = registrationWrappers.get(descriptor.value);
      else if (registrationKinds.has(property))
        descriptor.value = wrapRegistration(
          descriptor.value,
          registrationKinds.get(property),
        );
    }
    Object.defineProperty(callable, property, descriptor);
  }
  return wrapped;
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
      // SuiteContext has no skip/test methods. Hooks still receive a guarded
      // TestContext, but neither hooks nor suites gain isolation authority.
      if (allowIsolation || typeof context.skip === 'function')
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
    const testDescriptor = Object.getOwnPropertyDescriptor(prototype, 'test');
    if (
      !skipDescriptor ||
      typeof skipDescriptor.value !== 'function' ||
      !todoDescriptor ||
      typeof todoDescriptor.value !== 'function' ||
      !testDescriptor ||
      typeof testDescriptor.value !== 'function'
    )
      throw new Error('Node TestContext methods could not be guarded');

    const originalSkip = skipDescriptor.value;
    const testGuard = wrapRegistration(testDescriptor.value, true);
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
    Object.defineProperty(prototype, 'test', {
      ...testDescriptor,
      value: testGuard,
      writable: false,
      configurable: false,
    });
    guards = { skip: skipGuard, todo: todoGuard, test: testGuard };
    guardedPrototypes.set(prototype, guards);
  }

  Object.defineProperties(context, {
    skip: {
      value: guards.skip,
      writable: false,
      configurable: false,
      enumerable: false,
    },
    todo: {
      value: guards.todo,
      writable: false,
      configurable: false,
      enumerable: false,
    },
    test: {
      value: guards.test,
      writable: false,
      configurable: false,
      enumerable: false,
    },
  });
}

function activeRunnerState() {
  if (
    process.env.KRN_ISOLATION_GATE_PRELOAD !== '1' ||
    process.env.NODE_TEST_CONTEXT === undefined
  )
    return;
  delete process.env.KRN_ISOLATION_GATE_PRELOAD;

  runnerState = {
    capabilities: parseCapabilities(process.env.KRN_ISOLATION_CAPABILITIES),
    isCI: process.env.CI === 'true',
  };
  installNodeTestGuards();
  installRunnerApi();
}

activeRunnerState();
