import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { testRunnerArgs } from '../scripts/fast-check.ts';
import { testCeilingArguments } from '../scripts/lib/test-timeout.ts';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const suitePath = join(projectRoot, 'scripts/test-suite.mjs');

// The interval is a live handle, as in a real hang: only the ceiling and
// --test-force-exit end the file.
const hangingTest = [
  "import { test } from 'node:test';",
  "test('never settles', () => new Promise(() => { setInterval(() => {}, 1000); }));",
  "test('still runs', () => {});",
  '',
].join('\n');

async function withHangingFile(
  run: (file: string) => void | Promise<void>,
): Promise<void> {
  const stateRoot = join(projectRoot, '.krn/tmp');
  await mkdir(stateRoot, { recursive: true });
  const directory = await mkdtemp(join(stateRoot, 'test-ceiling-'));
  try {
    const file = join(directory, 'hang.test.mjs');
    await writeFile(file, hangingTest);
    await run(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// A child node --test that inherits NODE_TEST_CONTEXT skips its files as nested.
const { NODE_TEST_CONTEXT: _nested, ...outerEnv } = process.env;
const lowCeiling = { ...outerEnv, KRN_TEST_TIMEOUT_MS: '1000' };

test('the ceiling defaults to 60 s and an override lowers it', () => {
  assert.deepEqual(testCeilingArguments({}), [
    '--test-timeout=60000',
    '--test-force-exit',
  ]);
  assert.deepEqual(testCeilingArguments({ KRN_TEST_TIMEOUT_MS: '1000' }), [
    '--test-timeout=1000',
    '--test-force-exit',
  ]);
  assert.deepEqual(testCeilingArguments({ KRN_TEST_TIMEOUT_MS: 'soon' }), [
    '--test-timeout=60000',
    '--test-force-exit',
  ]);
});

test('npm test fails a test that never settles by name at the ceiling', async () => {
  await withHangingFile((file) => {
    const result = spawnSync(process.execPath, [suitePath, file], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: lowCeiling,
      timeout: 30_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.error, undefined, output);
    assert.notEqual(result.status, 0, output);
    assert.match(output, /not ok \d+ - never settles/u);
    assert.match(output, /test timed out after 1000ms/u);
    assert.match(output, /ok \d+ - still runs/u);
  });
});

test('npm run fast fails a test that never settles by name at the ceiling', async () => {
  await withHangingFile((file) => {
    const result = spawnSync(
      process.execPath,
      testRunnerArgs([file], lowCeiling).map((argument) =>
        argument === '--test-reporter=dot' ? '--test-reporter=tap' : argument,
      ),
      { cwd: projectRoot, encoding: 'utf8', env: lowCeiling, timeout: 30_000 },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.error, undefined, output);
    assert.equal(result.status, 1, output);
    assert.match(output, /not ok \d+ - never settles/u);
    assert.match(output, /test timed out after 1000ms/u);
  });
});
