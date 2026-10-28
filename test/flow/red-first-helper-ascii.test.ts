import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('red-first helper sources are ASCII and preserve isolation skip parsing', async () => {
  const module = await import('../../src/flow/repository.ts');
  for (const name of [
    'nodeTestWrapper',
    'runnerSetup',
    'readyShim',
    'asciiHelperSource',
    'writeHelperSource',
  ]) {
    assert.equal(
      typeof module[name as keyof typeof module],
      'function',
      `${name} helper seam exists`,
    );
  }

  const directory = mkdtempSync(join(tmpdir(), 'krn-red-first-ascii-'));
  try {
    const {
      asciiHelperSource,
      nodeTestReporter,
      nodeTestWrapper,
      runnerSetup,
      readyShim,
    } = module;
    const sources = [
      nodeTestReporter,
      nodeTestWrapper(join(directory, 'tést.test.mjs')),
      runnerSetup([join(directory, 'rüñner.mjs')]),
      readyShim(join(directory, 'envïronment.mjs')),
    ].map(asciiHelperSource);
    for (const source of sources)
      assert.ok(Buffer.from(source).every((byte) => byte < 0x80));

    const reporterPath = join(directory, 'reporter.mjs');
    const testPath = join(directory, 'skip.test.mjs');
    const reporterSource = sources[0];
    if (typeof reporterSource !== 'string')
      throw new Error('reporter helper missing');
    writeFileSync(reporterPath, reporterSource);
    writeFileSync(
      testPath,
      [
        "import { test } from 'node:test';",
        "test('isolation skip', { skip: 'SKIP(isolation): x — missing bwrap user namespaces, systemd user scopes' }, () => {});",
        "test('other skip', { skip: 'ordinary reason' }, () => {});",
      ].join('\n'),
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      ['--test', `--test-reporter=${reporterPath}`, testPath],
      { encoding: 'utf8', env },
    );
    assert.equal(result.status, 0, result.stderr);
    const reportLine = result.stdout
      .split('\n')
      .find((line) => line.startsWith('KRN_NODE_TEST_REPORT:'));
    assert.ok(reportLine, result.stdout);
    const report = JSON.parse(
      reportLine.slice('KRN_NODE_TEST_REPORT:'.length),
    ) as { skipped: number; isolationSkipped: number };
    assert.equal(report.skipped, 2);
    assert.equal(report.isolationSkipped, 1);
    assert.ok(
      Buffer.from(readFileSync(reporterPath)).every((byte) => byte < 0x80),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runner helper copies preserve source bytes while generated helpers stay ASCII', async () => {
  const module = await import('../../src/flow/repository.ts');
  for (const name of ['writeHelperSource', 'asciiHelperSource']) {
    assert.equal(
      typeof module[name as keyof typeof module],
      'function',
      `${name} helper seam exists`,
    );
  }
  const { writeHelperSource, asciiHelperSource } = module;
  const directory = mkdtempSync(join(tmpdir(), 'krn-red-first-copy-'));
  try {
    const runnerSource = "export const value = 'é—';\n";
    const runnerPath = join(directory, 'runner.mjs');
    writeHelperSource(runnerPath, runnerSource);
    assert.deepEqual(readFileSync(runnerPath), Buffer.from(runnerSource));

    const generatedSource = asciiHelperSource("export const value = 'é—';\n");
    const generatedPath = join(directory, 'generated.mjs');
    writeHelperSource(generatedPath, generatedSource, true);
    assert.ok(
      Buffer.from(readFileSync(generatedPath)).every((byte) => byte < 0x80),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
