import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { globSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countIsolationSkips,
  isolationSummary,
  testSuiteExitCode,
  testSuiteSummaryIsValid,
} from './isolation-gate.mjs';
import {
  formatIsolationProbe,
  probeIsolationCapabilities,
} from './probe-isolation.mjs';

export const TEST_FILE_GLOB = 'test/**/*.test.{ts,js,mjs,cjs}';
const SCOPE_PROBE_TEST_PATTERN =
  '^scope probe sentinel keeps one selected test valid$';
const SCOPE_PROBE_TEST_FILE = 'test/isolation-gate.test.ts';

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const nestedScopeProbe =
    process.env.KRN_SCOPE_PROBE === '1' &&
    process.env.NODE_TEST_CONTEXT !== undefined;
  const inheritedCapabilities =
    process.env.KRN_SCOPE_PROBE === '1' &&
    process.env.KRN_ISOLATION_CAPABILITIES
      ? JSON.parse(process.env.KRN_ISOLATION_CAPABILITIES)
      : undefined;
  const capabilities = inheritedCapabilities ?? probeIsolationCapabilities();
  if (!inheritedCapabilities)
    process.stdout.write(`${formatIsolationProbe(capabilities)}\n`);
  let stdout = '';
  const requestedTestFiles = process.argv.slice(2);
  const scopeProbeFiles = nestedScopeProbe
    ? globSync(TEST_FILE_GLOB, { dot: true })
    : [];
  const projectTestRoot = resolve('test');
  const scopeProbeFilesValid =
    !nestedScopeProbe ||
    (scopeProbeFiles.length > 0 &&
      scopeProbeFiles.some(
        (file) => resolve(file) === resolve(SCOPE_PROBE_TEST_FILE),
      ) &&
      scopeProbeFiles.every((file) =>
        resolve(file).startsWith(`${projectTestRoot}${sep}`),
      ));
  const testFiles = nestedScopeProbe
    ? [SCOPE_PROBE_TEST_FILE]
    : requestedTestFiles.length === 0
      ? [TEST_FILE_GLOB]
      : requestedTestFiles;
  const approvalToken = randomBytes(32).toString('hex');
  const testRunnerEnv = {
    ...process.env,
    KRN_ISOLATION_CAPABILITIES: JSON.stringify(capabilities),
    KRN_ISOLATION_APPROVAL_TOKEN: approvalToken,
  };
  // Check the configured project test glob, then run one sentinel so a nested
  // scope probe proves discovery without executing the full suite recursively.
  if (nestedScopeProbe) delete testRunnerEnv.NODE_TEST_CONTEXT;
  const child = spawn(
    process.execPath,
    [
      '--import',
      fileURLToPath(new URL('./isolation-gate.mjs', import.meta.url)),
      '--test',
      ...(nestedScopeProbe
        ? [`--test-name-pattern=${SCOPE_PROBE_TEST_PATTERN}`]
        : []),
      '--test-concurrency=1',
      '--test-reporter=tap',
      ...testFiles,
    ],
    {
      detached: process.platform !== 'win32',
      env: testRunnerEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let forwardedSignal;
  const forwardSignal = (signal) => {
    if (forwardedSignal) return;
    forwardedSignal = signal;
    const sendSignal = () => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (error?.code !== 'ESRCH')
          process.stderr.write(
            `Unable to forward ${signal} to test process group: ${error.message}\n`,
          );
      }
    };
    if (child.pid) sendSignal();
    else child.once('spawn', sendSignal);
  };
  process.once('SIGINT', () => forwardSignal('SIGINT'));
  process.once('SIGTERM', () => forwardSignal('SIGTERM'));
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  child.once('error', (error) => {
    process.stderr.write(
      `Unable to start Node test runner: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
  child.once('close', async (code) => {
    const skipCount = countIsolationSkips(stdout, approvalToken);
    const summary = isolationSummary(skipCount);
    const testCount = Number(stdout.match(/^# tests (\d+)$/mu)?.[1] ?? 0);
    // TAP represents an empty loaded test file as one root subtest.
    const emptyTestFileCount =
      stdout.match(/^# Subtest: .+\.test\.(?:ts|js|mjs|cjs)$/gmu)?.length ?? 0;
    const selectedTestCount = Math.max(0, testCount - emptyTestFileCount);
    const skippedTestCount = Number(
      stdout.match(/^# skipped (\d+)$/mu)?.[1] ?? 0,
    );
    const todoCount = Number(stdout.match(/^# todo (\d+)$/mu)?.[1] ?? 0);
    process.stdout.write(`${summary}\n`);
    if (
      process.env.CI === 'true' &&
      process.env.GITHUB_STEP_SUMMARY &&
      process.env.KRN_SCOPE_PROBE !== '1'
    ) {
      const formatCapability = ({ available, reason }) =>
        available ? 'available' : `unavailable (${reason})`;
      const markdown = [
        '## CI test summary',
        '',
        `- Tests: ${testCount}`,
        `- ${summary}`,
        `- bwrap: ${formatCapability(capabilities.bwrap)}`,
        `- systemd user scopes: ${formatCapability(capabilities.systemdUserScope)}`,
        '',
      ].join('\n');
      await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
    }
    const testExitCode = forwardedSignal
      ? forwardedSignal === 'SIGINT'
        ? 130
        : 143
      : testSuiteExitCode(
          code ?? 1,
          skipCount,
          process.env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS === '1',
        );
    const summaryValid = testSuiteSummaryIsValid({
      selectedTestCount,
      skippedTestCount,
      todoCount,
      approvedSkipCount: skipCount,
    });
    const scopeProbeValid =
      !nestedScopeProbe || (scopeProbeFilesValid && selectedTestCount === 1);
    if (nestedScopeProbe && !scopeProbeFilesValid)
      process.stderr.write(
        'nested scope probe did not resolve a non-empty test-only project glob\n',
      );
    if (process.env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS === '1' && skipCount > 0)
      process.stderr.write(
        `gate:local requires zero isolation skips; observed ${skipCount}\n`,
      );
    process.exitCode =
      testExitCode === 0 && (!summaryValid || !scopeProbeValid)
        ? 1
        : testExitCode;
  });
}
