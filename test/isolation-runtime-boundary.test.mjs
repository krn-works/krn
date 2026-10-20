import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

async function fixtures(callback) {
  const stateRoot = join(process.cwd(), '.krn/tmp');
  await mkdir(stateRoot, { recursive: true });
  const directory = await mkdtemp(join(stateRoot, 'runtime-boundary-'));
  let sequence = 0;
  const run = async (source) => {
    const fixture = join(directory, `${sequence++}.test.mjs`);
    await writeFile(fixture, source);
    const result = spawnSync(process.execPath, [wrapper, fixture], {
      env: environment,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const details = `${result.stdout}\n${result.stderr}`
      .split(/\r?\n/u)
      .map((line) => `child> ${line}`)
      .join('\n');
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, details);
    return { ...result, details };
  };
  try {
    await callback(run, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('requirement decisions use the same validated snapshot', async (t) => {
  await fixtures(async (run) => {
    for (const [name, setup] of Object.entries({
      'custom iterator hides unknown indexed value': `const required = ['unrecognizedCapability'];
required[Symbol.iterator] = function* () { yield 'bwrap'; };`,
      'accessor changes value between validation and decision': `let reads = 0;
const required = [];
Object.defineProperty(required, '0', { get() { return reads++ === 0 ? 'bwrap' : 'unrecognizedCapability'; } });`,
      'custom iterator and filter hide unknown value': `const required = ['unrecognizedCapability'];
required[Symbol.iterator] = function* () { yield 'bwrap'; };
required.filter = () => ['bwrap'];`,
    })) {
      await t.test(name, async () => {
        const result = await run(`import test from 'node:test';
import { requiresIsolation } from ${JSON.stringify(helper)};
test('invalid requirements', (context) => {
  ${setup}
  requiresIsolation(context, 'invalid requirements', required);
});`);
        // Assert the public wrapper outcome here: an assertion inside a test
        // marked skipped could itself be hidden by the bug being observed.
        assert.equal(result.status, 1, result.details);
        assert.match(result.stdout, /^# skipped 0$/mu, result.details);
        assert.match(
          result.stdout,
          /requiresIsolation received (?:unknown capability|invalid test metadata)/u,
          result.details,
        );
      });
    }
    await t.test(
      'empty and known requirements retain honest decisions',
      async () => {
        const result = await run(`import assert from 'node:assert/strict';
import test from 'node:test';
import { requiresIsolation } from ${JSON.stringify(helper)};
test('empty requirements', (context) => assert.equal(requiresIsolation(context, 'empty requirements', []), true));
test('known requirements', (context) => {
  const required = ['bwrap'];
  required.filter = () => [];
  assert.equal(requiresIsolation(context, 'known requirements', required), false);
});`);
        assert.equal(result.status, 0, result.details);
        assert.match(result.stdout, /^# pass 1$/mu, result.details);
        assert.match(result.stdout, /^# skipped 1$/mu, result.details);
        assert.match(
          result.stdout,
          /SKIP\(isolation\): known requirements — missing bwrap user namespaces/u,
          result.details,
        );
      },
    );
  });
});

test('guarded node:test refuses separate runners through every exposed run alias', async (t) => {
  await fixtures(async (run, directory) => {
    const inner = join(directory, 'inner.test.mjs');
    await writeFile(
      inner,
      "import test from 'node:test'; test('unguarded nested skip', { skip: 'SKIP(isolation): nested runner' }, () => {});",
    );
    for (const [loader, prelude] of Object.entries({
      esm: "import api, { run as namedRun } from 'node:test';",
      cjs: "import { createRequire } from 'node:module'; const api = createRequire(import.meta.url)('node:test'); const namedRun = api.run;",
      builtin:
        "const api = process.getBuiltinModule('node:test'); const namedRun = api.run;",
    })) {
      await t.test(loader, async () => {
        const result = await run(`${prelude}
import assert from 'node:assert/strict';
api('run boundary and honest context', (context) => {
  assert.equal(api.getTestContext(), context);
  delete process.env.NODE_TEST_CONTEXT;
  const runners = [namedRun];
  const seen = new Set();
  const pending = [api];
  while (pending.length) {
    const fn = pending.shift();
    if (seen.has(fn)) continue;
    seen.add(fn);
    for (const key of Reflect.ownKeys(fn)) {
      const value = Object.getOwnPropertyDescriptor(fn, key).value;
      if (typeof value !== 'function') continue;
      if (key === 'run') runners.push(fn[key], value);
      else pending.push(value);
    }
  }
  assert.ok(runners.length > 1);
  for (const runner of runners) assert.throws(
    () => runner({ files: [${JSON.stringify(inner)}], concurrency: 1 }),
    /node:test.run is not permitted by the isolation gate/,
  );
  assert.equal(api.getTestContext(), context);
});`);
        assert.equal(result.status, 0, result.details);
        assert.match(result.stdout, /^# tests 1$/mu, result.details);
        assert.match(result.stdout, /^# pass 1$/mu, result.details);
        assert.match(result.stdout, /^# skipped 0$/mu, result.details);
      });
    }
  });
});
