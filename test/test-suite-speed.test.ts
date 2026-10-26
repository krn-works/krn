import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const wrapper = fileURLToPath(
  new URL('../scripts/test-suite.mjs', import.meta.url),
);

async function fixture() {
  const state = resolve('.krn/tmp');
  await mkdir(state, { recursive: true });
  const root = await mkdtemp(join(state, 'test-suite-speed-'));
  const project = join(root, 'project');
  await mkdir(join(project, 'test'), { recursive: true });
  await writeFile(join(project, '.node-version'), process.version.slice(1));
  await writeFile(join(project, 'package.json'), '{"type":"module"}');
  return { root, project };
}

function run(project: string, files: string[], extra: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST_') || key === 'NODE_OPTIONS') delete env[key];
  }
  delete env.NODE_COMPILE_CACHE;
  delete env.KRN_SCOPE_PROBE;
  delete env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS;
  delete env.GITHUB_STEP_SUMMARY;
  return spawnSync(process.execPath, [wrapper, ...files], {
    cwd: project,
    env: {
      ...env,
      CI: 'true',
      pnpm_config_store_dir: join(project, '.krn/store'),
      ...extra,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function passed(result: ReturnType<typeof run>) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

for (const strict of [false, true]) {
  test(`test wrapper shares a persistent compile cache and reports durations (strict=${strict})`, async () => {
    const { root, project } = await fixture();
    try {
      const cache = join(project, '.krn/tmp/node-compile-cache');
      const summary = join(root, 'summary.md');
      await writeFile(
        join(project, 'value.ts'),
        'export const value: string = "original";',
      );
      for (const name of ['alpha', 'beta']) {
        await writeFile(
          join(project, 'test', `${name}.test.mjs`),
          `
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { flushCompileCache, getCompileCacheDir } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { value } from '../value.ts';
test('${name} top level', async (t) => {
  assert.equal(process.env.NODE_COMPILE_CACHE, ${JSON.stringify(cache)});
  assert.ok(getCompileCacheDir()?.startsWith(process.env.NODE_COMPILE_CACHE));
  assert.equal(value, process.env.KRN_EXPECTED_VALUE);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    'import { getCompileCacheDir } from "node:module"; console.log(JSON.stringify([process.env.NODE_COMPILE_CACHE, getCompileCacheDir()]))'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [process.env.NODE_COMPILE_CACHE, getCompileCacheDir()]);
  writeFileSync(${JSON.stringify(join(root, name))}, 'ready');
  const deadline = Date.now() + 15000;
  while (!existsSync(${JSON.stringify(join(root, name === 'alpha' ? 'beta' : 'alpha'))})) {
    assert.ok(Date.now() < deadline, 'other shard did not start');
    await setImmediate();
  }
  flushCompileCache();
  await t.test('${name} nested', () => {});
});`,
        );
      }
      const env = {
        KRN_TEST_SHARDS: '2',
        KRN_REQUIRE_ZERO_ISOLATION_SKIPS: strict ? '1' : '0',
        KRN_EXPECTED_VALUE: 'original',
        GITHUB_STEP_SUMMARY: summary,
      };
      const files = ['test/alpha.test.mjs', 'test/beta.test.mjs'];
      const first = run(project, files, env);
      passed(first);
      assert.match(first.stdout, /## Slowest tests \(top-level\)/u);
      const tableStart = first.stdout.indexOf('## Slowest tests');
      const table = first.stdout.slice(
        tableStart,
        first.stdout.indexOf('Isolation-dependent tests skipped:', tableStart),
      );
      assert.match(
        table,
        /alpha top level\s*\|\s*test\/alpha.test.mjs\s*\|\s*\d+\.\d{3}/u,
      );
      assert.match(table, /beta top level\s*\|\s*test\/beta.test.mjs/u);
      assert.doesNotMatch(table, /alpha nested|beta nested/u);
      assert.ok((await readFile(summary, 'utf8')).includes(table.trim()));
      assert.ok((await readdir(cache)).length > 0);
      assert.deepEqual((await readdir(join(project, '.krn/tmp'))).sort(), [
        'node-compile-cache',
      ]);
      if (strict) {
        const line = first.stdout
          .split('\n')
          .find((line) => line.startsWith('KRN_TEST_SUMMARY_JSON='));
        assert.ok(line);
        const parsed = JSON.parse(line.slice('KRN_TEST_SUMMARY_JSON='.length));
        assert.deepEqual(Object.keys(parsed).sort(), [
          'counts',
          'files',
          'success',
          'version',
        ]);
        assert.equal(parsed.counts.tests, 4);
        assert.equal(parsed.success, true);
      }
      // Corrupt only this fixture's cache, without depending on Node's layout.
      for (const entry of await readdir(cache, {
        recursive: true,
        withFileTypes: true,
      })) {
        if (entry.isFile())
          await writeFile(join(entry.parentPath, entry.name), 'broken cache');
      }
      passed(run(project, files, env));
      await writeFile(
        join(project, 'value.ts'),
        'export const value: string = "modified";',
      );
      passed(run(project, files, { ...env, KRN_EXPECTED_VALUE: 'modified' }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('test wrapper preserves caller cache and tolerates an unusable cache directory', async () => {
  const { root, project } = await fixture();
  try {
    const file = 'test/cache.test.mjs';
    await writeFile(
      join(project, file),
      `
import assert from 'node:assert/strict';
import { getCompileCacheDir } from 'node:module';
import { test } from 'node:test';
test('caller cache', () => {
  assert.equal(process.env.NODE_COMPILE_CACHE, process.env.KRN_EXPECTED_CACHE);
  assert.equal(Boolean(getCompileCacheDir()), process.env.KRN_CACHE_ENABLED === '1');
});`,
    );
    const preset = join(root, 'caller-cache');
    for (const strict of ['0', '1']) {
      passed(
        run(project, [file], {
          NODE_COMPILE_CACHE: preset,
          KRN_EXPECTED_CACHE: preset,
          KRN_CACHE_ENABLED: '1',
          KRN_REQUIRE_ZERO_ISOLATION_SKIPS: strict,
        }),
      );
    }
    // A regular file makes the default cache path unusable even as root.
    const blocked = join(project, '.krn/tmp/node-compile-cache');
    await writeFile(blocked, 'owned sentinel');
    passed(
      run(project, [file], {
        KRN_EXPECTED_CACHE: blocked,
        KRN_CACHE_ENABLED: '0',
      }),
    );
    assert.equal(await readFile(blocked, 'utf8'), 'owned sentinel');
    const unwritable = join(root, 'unwritable-cache');
    await mkdir(unwritable, { mode: 0o500 });
    try {
      passed(
        run(project, [file], {
          NODE_COMPILE_CACHE: unwritable,
          KRN_EXPECTED_CACHE: unwritable,
          KRN_CACHE_ENABLED: process.getuid?.() === 0 ? '1' : '0',
          KRN_REQUIRE_ZERO_ISOLATION_SKIPS: '1',
        }),
      );
    } finally {
      await chmod(unwritable, 0o700);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('test wrapper includes failing tests and handles an empty duration summary', async () => {
  const { root, project } = await fixture();
  try {
    const file = 'test/outcome.test.mjs';
    await writeFile(
      join(project, file),
      "import { test } from 'node:test'; test('failed outcome', () => { throw Error('expected failure'); });",
    );
    for (const strict of ['0', '1']) {
      const failed = run(project, [file], {
        KRN_REQUIRE_ZERO_ISOLATION_SKIPS: strict,
      });
      assert.equal(failed.status, 1, failed.stderr);
      assert.match(
        failed.stdout,
        /\| failed outcome \| test\/outcome.test.mjs \| \d+\.\d{3} \|/u,
      );
    }
    await rm(join(project, file));
    for (const strict of ['0', '1']) {
      const empty = run(project, [file], {
        KRN_REQUIRE_ZERO_ISOLATION_SKIPS: strict,
      });
      assert.equal(empty.status, 1);
      assert.match(empty.stdout, /No test durations recorded\./u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
