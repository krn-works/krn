import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const wrapper = fileURLToPath(
  new URL('../scripts/test-suite.mjs', import.meta.url),
);
const helper = new URL('./helpers/isolation.ts', import.meta.url).href;
const environment = {
  CI: 'true',
  KRN_SCOPE_PROBE: '1',
  KRN_ISOLATION_CAPABILITIES: JSON.stringify({
    bwrap: { available: false },
    systemdUserScope: { available: false },
  }),
};
const loaders = {
  esm: "import api, * as named from 'node:test';",
  cjs: "import { createRequire } from 'node:module'; const api = createRequire(import.meta.url)('node:test'); const named = api;",
  builtin:
    "const api = process.getBuiltinModule('node:test'); const named = api;",
};

// Inspect the pinned native API in a fresh process, before the wrapper is loaded.
// Visit each distinct registration function and every incoming public alias;
// cyclic test/it/test chains are represented by their edges, not a depth limit.
const discovery = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `import api from 'node:test';
// Native source audit: run creates a separate runner/TestsStream, while
// getTestContext reads the current context. Every other function-valued export
// registers a test, suite, variant or hook. Discover nested variants as well.
const utilities = new Set([api.run, api.getTestContext]);
const roots = Reflect.ownKeys(api).filter((key) => typeof api[key] === 'function' && !utilities.has(api[key]));
const registrations = new Set([api]);
const pending = [api];
while (pending.length) {
  const fn = pending.shift();
  for (const key of Reflect.ownKeys(fn)) {
    const value = Object.getOwnPropertyDescriptor(fn, key).value;
    if (typeof value !== 'function' || utilities.has(value) || registrations.has(value)) continue;
    registrations.add(value);
    pending.push(value);
  }
}
const aliases = new Map([['api', api], ...roots.map((key) => ['named.' + key, api[key]])]);
const visited = new Set();
const queue = [...aliases];
while (queue.length) {
  const [path, fn] = queue.shift();
  if (visited.has(fn)) continue;
  visited.add(fn);
  for (const key of Reflect.ownKeys(fn)) {
    const value = Object.getOwnPropertyDescriptor(fn, key).value;
    if (!registrations.has(value)) continue;
    const alias = path + '.' + key;
    aliases.set(alias, value);
    queue.push([alias, value]);
  }
}
// Exercise every edge from each exported alias as well as canonical nodes.
for (const [path, fn] of [...aliases]) for (const key of Reflect.ownKeys(fn)) {
  const value = Object.getOwnPropertyDescriptor(fn, key).value;
  if (registrations.has(value)) aliases.set(path + '.' + key, value);
}
console.log(JSON.stringify([...aliases.keys()]));`,
  ],
  { env: {}, encoding: 'utf8', timeout: 30_000 },
);
assert.equal(discovery.status, 0, discovery.stderr);
const aliases = JSON.parse(discovery.stdout);
for (const required of [
  'named.it.only',
  'api.it.only',
  'named.describe.only',
  'named.suite.only',
  'api.it.test',
  'api.it.describe',
  'api.it.suite',
  'named.test.only',
  'named.only',
  'api.test.only',
  'named.expectFailure',
  'api.it.expectFailure',
  'named.describe.expectFailure',
  'named.suite.expectFailure',
])
  assert.ok(aliases.includes(required), `missing native alias: ${required}`);

test('public registration alias graph rejects forged skips and preserves honest controls', {
  concurrency: 2,
}, async (t) => {
  const stateRoot = join(process.cwd(), '.krn/tmp');
  await mkdir(stateRoot, { recursive: true });
  const directory = await mkdtemp(join(stateRoot, 'registration-aliases-'));
  let sequence = 0;
  const run = async (source) => {
    const fixture = join(directory, `${sequence++}.test.mjs`);
    await writeFile(fixture, source);
    const child = spawn(process.execPath, [wrapper, fixture], {
      cwd: process.cwd(),
      env: environment,
      timeout: 30_000,
    });
    const stdout = [];
    const stderr = [];
    let error;
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (cause) => {
      error = cause;
    });
    const result = await new Promise((resolve) => {
      child.on('close', (status, signal) => {
        resolve({
          status,
          signal,
          error,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        });
      });
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, result.stderr);
    return result;
  };
  const cases = [];
  const add = (name, fn) => cases.push(t.test(name, fn));
  try {
    for (const [loader, prelude] of Object.entries(loaders)) {
      add(`${loader} every alias rejects registration skip`, async () => {
        // Rejection is synchronous and occurs before registration. Exercise
        // every edge in one child; a missing guard still fails assert.throws
        // for that exact alias (and cannot hide behind another failed case).
        const result = await run(`${prelude}
import assert from 'node:assert/strict';
${aliases.map((alias) => `api(${JSON.stringify(alias)}, () => assert.throws(() => ${alias}('forged registration', { skip: 'SKIP(isolation): forged registration' }, () => {}), /Registration-level (?:skips|todo).*not permitted/, ${JSON.stringify(alias)}));`).join('\n')}`);
        const details = `${result.stdout}\n${result.stderr}`;
        assert.equal(result.status, 0, details);
        assert.match(result.stdout, /^# skipped 0$/mu, details);
        assert.match(
          result.stdout,
          new RegExp(`^# pass ${aliases.length}$`, 'mu'),
          details,
        );
      });
      add(
        `${loader} honest callback, suite, hook and static controls`,
        async () => {
          const result = await run(`${prelude}
import assert from 'node:assert/strict';
import { requiresIsolation } from ${JSON.stringify(helper)};
assert.equal(api.test, api);
assert.equal(api.it, api);
assert.equal(api.describe, api.suite);
for (const root of [api, api.it, api.describe, api.suite]) {
  for (const key of Reflect.ownKeys(root)) {
    const descriptor = Object.getOwnPropertyDescriptor(root, key);
    if ('value' in descriptor) assert.equal(descriptor.value, root[key]);
  }
}
let hooks = 0;
let expectedFailureReached = false;
api.after(() => assert.equal(expectedFailureReached, true));
api.before((context) => {
  hooks++;
  assert.throws(() => requiresIsolation(context, 'hook cannot approve', ['systemdUserScope']), /active TestContext/);
});
api.describe.only('honest suite', (context) => {
  assert.throws(() => requiresIsolation(context, 'suite cannot approve', ['systemdUserScope']), /active TestContext/);
  api.it.only('honest nested alias', (context) => {
    assert.equal(hooks, 1);
    assert.equal(requiresIsolation(context, 'honest nested alias', ['systemdUserScope']), false);
  });
});
api.it.test((context) => {
  assert.equal(requiresIsolation(context, 'honest callback-only alias', ['systemdUserScope']), false);
});
api.test.only('honest async alias', async (context) => {
  await Promise.resolve();
  assert.equal(requiresIsolation(context, 'honest async alias', ['systemdUserScope']), false);
});
api.it.expectFailure('honest expected failure', (context) => {
  assert.equal(requiresIsolation(context, 'honest expected failure', []), true);
  assert.equal(api.getTestContext(), context);
  expectedFailureReached = true;
  throw new Error('intentional expected failure');
});`);
          const details = `${result.stdout}\n${result.stderr}`;
          assert.equal(result.status, 0, details);
          assert.match(result.stdout, /^# tests 4$/mu, details);
          assert.match(result.stdout, /^# pass 1$/mu, details);
          assert.match(result.stdout, /^# skipped 3$/mu, details);
          assert.match(
            result.stdout,
            /Isolation-dependent tests skipped: 3$/mu,
            details,
          );
        },
      );
      for (const root of ['api.it', 'api.suite']) {
        for (const variant of ['only', 'expectFailure']) {
          add(
            root === 'api.it' && variant === 'only'
              ? `${loader} reflected aliases reject forged skips`
              : `${loader} reflected ${root}.${variant} rejects forged skip`,
            async () => {
              const result = await run(`${prelude}
Object.getOwnPropertyDescriptor(${root}, '${variant}').value('forged reflected registration', { skip: 'SKIP(isolation): forged reflected registration' }, () => {});`);
              const details = `${result.stdout}\n${result.stderr}`;
              assert.equal(result.status, 1, details);
              assert.match(result.stdout, /^# skipped 0$/mu, details);
              assert.match(
                result.stdout,
                /Registration-level skips.*not permitted/u,
                details,
              );
            },
          );
        }
      }
    }
  } finally {
    await Promise.all(cases.map((result) => result.catch(() => undefined)));
    await rm(directory, { recursive: true, force: true });
  }
});
