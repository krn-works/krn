import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { type TestContext, test } from 'node:test';

const gateLocal = new URL('../scripts/gate-local.mjs', import.meta.url);

function fixture(t: TestContext) {
  const parent = resolve('.krn/tmp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'gate-local-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path: string, source: string) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  };
  return { root, put };
}

async function select(root: string): Promise<string[]> {
  const module = await import(gateLocal.href);
  assert.equal(typeof module.selectIsolationTestFiles, 'function');
  const files: unknown = module.selectIsolationTestFiles(root);
  assert.ok(Array.isArray(files));
  assert.ok(files.every((file: unknown) => typeof file === 'string'));
  return files;
}

test('local isolation selection matches the repository isolation-test inventory exactly', async () => {
  // This inventory excludes tests that only generate isolated child fixtures.
  // A newly selected file needs an explicit isolation-test impact review here.
  assert.deepEqual(await select(process.cwd()), [
    'test/evals/session.test.ts',
    'test/evals/workspace.test.ts',
    'test/flow/red-first-sandbox.test.ts',
    'test/flow/repository-metadata.test.ts',
    'test/flow/review-observations.test.ts',
    'test/flow/review-parallel.test.ts',
    'test/flow/review-round-two.test.ts',
    'test/flow/review.test.ts',
    'test/foreman/delivery-trailers.test.ts',
    'test/foreman/interrupted-resume.test.ts',
    'test/hosts/codex-cancel.test.ts',
    'test/hosts/codex-env.test.ts',
    'test/hosts/codex-launch.test.ts',
    'test/hosts/codex-line-limit.test.ts',
    'test/hosts/codex-registration.test.ts',
    'test/hosts/codex-stale-scope.test.ts',
    'test/hosts/codex-usage-completeness.test.ts',
    'test/hosts/codex-usage.test.ts',
    'test/live-smoke-signal.test.ts',
    'test/live/outcome.test.ts',
    'test/ship/checkpoint-commit.test.ts',
    'test/ship/delivery-authority.test.ts',
    'test/ship/delivery-isolation.test.ts',
    'test/ship/delivery-progress.test.ts',
    'test/verdict/npm-runtime.test.mjs',
    'test/verdict/sandbox-orphans.test.ts',
    'test/verdict/sandbox-temp-capacity.test.ts',
    'test/verdict/sandbox.test.ts',
  ]);
});

test('local isolation selection discovers imports deterministically without selecting fixture text', async (t) => {
  const f = fixture(t);
  f.put(
    'test/nested/static.test.ts',
    "import { requiresIsolation as requireHost } from '../helpers/../helpers/isolation.ts';\n",
  );
  f.put(
    'test/dynamic.test.mjs',
    "const { requiresIsolation } = await import('./helpers/isolation.ts');\n",
  );
  f.put(
    'test/common.test.cjs',
    "const { requiresIsolation } = require('./helpers/isolation.ts');\n",
  );
  f.put(
    'test/plain.test.ts',
    [
      '// import { requiresIsolation } from "./helpers/isolation.ts";',
      '/* import("./helpers/isolation.ts"); */',
      'const fixture = `import { requiresIsolation } from "./helpers/isolation.ts";`;',
      'const quoted = "import(\'./helpers/isolation.ts\')";',
      'import type { requiresIsolation } from "./helpers/isolation.ts";',
      'import "./other/isolation.ts";',
    ].join('\n'),
  );
  f.put(
    '.krn/worktrees/foreign/test/foreign.test.ts',
    "import '../helpers/isolation.ts';\n",
  );
  assert.deepEqual(await select(f.root), [
    'test/common.test.cjs',
    'test/dynamic.test.mjs',
    'test/nested/static.test.ts',
  ]);
  f.put('test/added.test.ts', "import './helpers/isolation.ts';\n");
  assert.deepEqual(await select(f.root), [
    'test/added.test.ts',
    'test/common.test.cjs',
    'test/dynamic.test.mjs',
    'test/nested/static.test.ts',
  ]);
});

test('local isolation selection follows helper imports and re-exports within the project test root', async (t) => {
  const f = fixture(t);
  f.put(
    'test/helpers/isolation.ts',
    'export const requiresIsolation = () => {};\n',
  );
  f.put(
    'test/helpers/host.ts',
    "export { requiresIsolation } from './isolation.ts';\n",
  );
  f.put('test/helpers/barrel.ts', "export * from './host.ts';\n");
  f.put(
    'test/indirect.test.ts',
    "import { requiresIsolation } from './helpers/barrel.ts';\n",
  );
  f.put(
    'test/helpers/dynamic.mjs',
    "export const host = await import('./host.ts');\n",
  );
  f.put('test/dynamic-helper.test.mjs', "import './helpers/dynamic.mjs';\n");
  f.put('test/helpers/common.cjs', "module.exports = require('./host.ts');\n");
  f.put('test/common-helper.test.cjs', "require('./helpers/common.cjs');\n");
  f.put('test/plain.test.ts', "import './helpers/plain.ts';\n");
  f.put(
    'test/helpers/plain.ts',
    [
      '// export * from "./isolation.ts";',
      'const fixture = `export * from "./isolation.ts";`;',
      'export type { requiresIsolation } from "./isolation.ts";',
      'import "../../outside.ts";',
    ].join('\n'),
  );
  f.put('outside.ts', "import './test/helpers/isolation.ts';\n");

  assert.deepEqual(await select(f.root), [
    'test/common-helper.test.cjs',
    'test/dynamic-helper.test.mjs',
    'test/indirect.test.ts',
  ]);
});

test('local isolation selection handles shared cycles with and without an isolation dependency', async (t) => {
  const f = fixture(t);
  f.put(
    'test/helpers/isolation.ts',
    'export const requiresIsolation = () => {};\n',
  );
  f.put(
    'test/helpers/host.ts',
    "import './cycle.ts';\nexport * from './isolation.ts';\n",
  );
  f.put('test/helpers/cycle.ts', "export * from './host.ts';\n");
  f.put('test/host.test.ts', "import './helpers/host.ts';\n");
  f.put('test/cycle.test.ts', "import './helpers/cycle.ts';\n");
  f.put('test/helpers/plain.ts', "import './other.ts';\n");
  f.put('test/helpers/other.ts', "import './plain.ts';\n");
  f.put('test/plain.test.ts', "import './helpers/plain.ts';\n");

  assert.deepEqual(await select(f.root), [
    'test/cycle.test.ts',
    'test/host.test.ts',
  ]);
});

test('gate-local runs preflight before only the strict isolation files and stops on preflight failure', async (t) => {
  for (const preflightExit of [0, 23]) {
    await t.test(`preflight exits ${preflightExit}`, async (t) => {
      const f = fixture(t);
      f.put('test/host.test.ts', "import './helpers/isolation.ts';\n");
      f.put('test/plain.test.ts', 'export {};\n');
      f.put(
        'bin/git',
        '#!/usr/bin/env node\nif (process.argv[2] === "rev-parse") console.log("a".repeat(40));\n',
      );
      f.put(
        'bin/npm',
        `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync('npm.jsonl', JSON.stringify({ args, strict: process.env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS ?? null }) + '\\n');
if (args[1] === 'preflight') process.exit(${preflightExit});
const counts = { tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0 };
console.log('Isolation-dependent tests skipped: 0');
console.log('KRN_TEST_SUMMARY_JSON=' + JSON.stringify({ version: 1, success: true, counts, files: [{ file: 'test/host.test.ts', ...counts }] }));
`,
      );
      f.put(
        'bin/gh',
        "#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs'; appendFileSync('gh.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');\n",
      );
      for (const name of ['git', 'npm', 'gh'])
        chmodSync(join(f.root, 'bin', name), 0o755);
      const env = { ...process.env };
      delete env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS;
      env.KRN_GH_BIN = join(f.root, 'bin/gh');
      env.PATH = `${join(f.root, 'bin')}${delimiter}${env.PATH ?? ''}`;
      const result = spawnSync(process.execPath, [gateLocal.pathname], {
        cwd: f.root,
        env,
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(result.error, undefined, result.stderr);
      const calls: unknown[] = readFileSync(join(f.root, 'npm.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.deepEqual(calls, [
        { args: ['run', 'preflight'], strict: null },
        ...(preflightExit === 0
          ? [{ args: ['test', '--', 'test/host.test.ts'], strict: '1' }]
          : []),
      ]);
      assert.equal(result.status, preflightExit, result.stderr);
      if (preflightExit !== 0)
        assert.throws(() => readFileSync(join(f.root, 'gh.jsonl')), /ENOENT/u);
      else
        assert.equal(
          readFileSync(join(f.root, 'gh.jsonl'), 'utf8').trim().split('\n')
            .length,
          1,
        );
    });
  }
});
