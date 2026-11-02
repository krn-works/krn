import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as isolationGate from '../scripts/isolation-gate.mjs';

assert.equal(
  typeof isolationGate.isolationCoverage,
  'function',
  'isolation-gate must export isolationCoverage',
);

const repositoryRoot = process.cwd();
const testSuite = resolve(repositoryRoot, 'scripts/test-suite.mjs');
const coverageLine =
  'KRN isolation evidence: 1 isolation files, 0 isolation skips';

function coverage(summaryFiles, isolationFiles, root = '/project') {
  return isolationGate.isolationCoverage(summaryFiles, isolationFiles, root);
}

async function makeFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'krn-isolation-evidence-')),
  );
  await mkdir(join(root, 'test/helpers'), { recursive: true });
  await mkdir(join(root, '.krn/tmp'), { recursive: true });
  await writeFile(
    join(root, '.node-version'),
    await readFile(join(repositoryRoot, '.node-version'), 'utf8'),
  );
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ private: true, packageManager: 'pnpm@12.10.1' }),
  );
  await writeFile(
    join(root, 'test/helpers/isolation.ts'),
    'export const helper = true;\n',
  );
  await writeFile(
    join(root, 'test/host.test.mjs'),
    [
      "import { test } from 'node:test';",
      "import './helpers/isolation.ts';",
      "test('fixture test passes', () => {});",
      '',
    ].join('\n'),
  );
  return root;
}

function suiteEnvironment(root, strict) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('KRN_') || key.startsWith('NODE_TEST_')) delete env[key];
  }
  delete env.NODE_OPTIONS;
  delete env.GITHUB_STEP_SUMMARY;
  if (strict) env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS = '1';
  env.pnpm_config_store_dir = join(root, '.pnpm-store');
  return env;
}

function runSuite(root, args, strict) {
  const result = spawnSync(process.execPath, [testSuite, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: suiteEnvironment(root, strict),
    timeout: 30_000,
  });
  assert.equal(
    result.error,
    undefined,
    `suite process failed to start or timed out: ${result.error?.message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

test('full strict discovery publishes isolation coverage after its summary', async () => {
  const root = await makeFixture();
  try {
    const result = runSuite(root, [], true);
    assert.equal(
      result.status,
      0,
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.deepEqual(
      result.stderr
        .split(/\r?\n/u)
        .filter((line) => line.startsWith('KRN isolation evidence:')),
      [coverageLine],
    );
    assert.doesNotMatch(result.stdout, /^KRN isolation evidence:/mu);
    const summaryLine = result.stdout
      .split(/\r?\n/u)
      .find((line) => line.startsWith('KRN_TEST_SUMMARY_JSON='));
    assert.ok(summaryLine, result.stdout);
    const summary = JSON.parse(
      summaryLine.slice('KRN_TEST_SUMMARY_JSON='.length),
    );
    assert.equal(summary.success, true);
    assert.deepEqual(
      summary.files.map(({ file }) => file),
      [join(root, 'test/host.test.mjs')],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('targeted strict and non-strict full runs do not publish isolation coverage', async () => {
  const root = await makeFixture();
  try {
    for (const [name, args, strict] of [
      ['targeted strict', ['test/host.test.mjs'], true],
      ['non-strict full', [], false],
    ]) {
      const result = runSuite(root, args, strict);
      assert.equal(
        result.status,
        0,
        `${name}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.doesNotMatch(result.stderr, /^KRN isolation evidence:/mu, name);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('isolation coverage accepts every selected file with real tests and no skips', () => {
  const result = coverage(
    [
      { file: '/project/test/host.test.mjs', tests: 2, skipped: 0 },
      { file: 'test/plain.test.mjs', tests: 1, skipped: 0 },
    ],
    ['test/host.test.mjs'],
  );
  assert.deepEqual(result, { ok: true, line: coverageLine, errors: [] });
});

test('isolation coverage rejects missing, zero-test, skipped, and malformed rows by file', () => {
  const cases = [
    {
      name: 'missing',
      rows: [{ file: 'test/other.test.mjs', tests: 1, skipped: 0 }],
      message: 'test/host.test.mjs (missing or malformed)',
    },
    {
      name: 'zero tests',
      rows: [{ file: 'test/host.test.mjs', tests: 0, skipped: 0 }],
      message: 'test/host.test.mjs (no tests)',
    },
    {
      name: 'one skip',
      rows: [{ file: 'test/host.test.mjs', tests: 1, skipped: 1 }],
      message: 'test/host.test.mjs (1 skipped)',
    },
    {
      name: 'missing file and counts',
      rows: [{ tests: '1', skipped: 0 }, { file: 'test/host.test.mjs' }],
      message: 'test/host.test.mjs (missing or malformed)',
    },
  ];
  for (const scenario of cases) {
    const result = coverage(scenario.rows, ['test/host.test.mjs']);
    assert.equal(result.ok, false, scenario.name);
    assert.equal(result.line, undefined, scenario.name);
    assert.ok(
      result.errors.some((error) => error.includes(scenario.message)),
      `${scenario.name}: ${result.errors.join('; ')}`,
    );
  }
});

test('isolation coverage rejects an empty selection and bounds rejection paths', () => {
  const empty = coverage([], []);
  assert.equal(empty.ok, false);
  assert.match(empty.errors.join('\n'), /no isolation files were selected/u);

  const files = Array.from(
    { length: 21 },
    (_, index) => `test/host-${index}.test.mjs`,
  );
  const bounded = coverage([], files);
  assert.equal(bounded.ok, false);
  assert.match(bounded.errors.join('\n'), /\+1 more/u);
  assert.doesNotMatch(bounded.errors.join('\n'), /host-20\.test/u);
});

test('isolation selection refuses a test file symlinked outside test/', async () => {
  const root = await makeFixture();
  const outside = join(root, 'outside.test.mjs');
  try {
    await writeFile(outside, "import './test/helpers/isolation.ts';\n");
    await symlink(outside, join(root, 'test/escape.test.mjs'));
    assert.throws(
      () =>
        isolationGate.selectIsolationTestFiles(
          root,
          'test/**/*.test.{ts,js,mjs,cjs}',
        ),
      /discovery escaped project test root/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('isolation selection skips a directory that matches the test glob', async () => {
  const root = await makeFixture();
  try {
    await mkdir(join(root, 'test/fixture.test.mjs'));
    await writeFile(
      join(root, 'test/host.test.mjs'),
      "import './helpers/isolation.ts';\n",
    );
    const selected = isolationGate.selectIsolationTestFiles(
      root,
      'test/**/*.test.{ts,js,mjs,cjs}',
    );
    assert.ok(
      selected.every((file) => !file.endsWith('fixture.test.mjs')),
      'a directory is never selected as an isolation test file',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
