import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import {
  isolationSummary,
  parseTapSummary,
  testSuiteExitCode,
} from './isolation-gate.mjs';
import {
  formatIsolationProbe,
  probeIsolationCapabilities,
} from './probe-isolation.mjs';

const inheritedCapabilities =
  process.env.KRN_SCOPE_PROBE === '1' && process.env.KRN_ISOLATION_CAPABILITIES
    ? JSON.parse(process.env.KRN_ISOLATION_CAPABILITIES)
    : undefined;
const capabilities = inheritedCapabilities ?? probeIsolationCapabilities();
if (!inheritedCapabilities)
  process.stdout.write(`${formatIsolationProbe(capabilities)}\n`);
let stdout = '';
const requestedTestFiles = process.argv.slice(2);
const child = spawn(
  process.execPath,
  [
    '--test',
    '--test-concurrency=1',
    '--test-reporter=tap',
    ...(requestedTestFiles.length > 0
      ? requestedTestFiles
      : ['test/**/*.test.ts']),
  ],
  {
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      KRN_ISOLATION_CAPABILITIES: JSON.stringify(capabilities),
    },
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
  process.stderr.write(`Unable to start Node test runner: ${error.message}\n`);
  process.exitCode = 1;
});
child.once('close', async (code) => {
  const testSummary = parseTapSummary(stdout);
  const isolationSkipCount = testSummary.isolationSkipNames.length;
  const summary = isolationSummary(testSummary.isolationSkipNames);
  process.stdout.write(`${summary}\n`);
  if (process.env.CI === 'true' && process.env.GITHUB_STEP_SUMMARY) {
    const formatCapability = ({ available, reason }) =>
      available ? 'available' : `unavailable (${reason})`;
    const markdown = [
      '## CI test summary',
      '',
      `- Tests: ${testSummary.testCount ?? 0}`,
      `- Isolation-dependent tests skipped: ${isolationSkipCount}`,
      '- Isolation skip names:',
      ...(testSummary.isolationSkipNames.length > 0
        ? testSummary.isolationSkipNames.map(
            (name) => `  - ${JSON.stringify(name)}`,
          )
        : ['  - none']),
      `- bwrap: ${formatCapability(capabilities.bwrap)}`,
      `- systemd user scopes: ${formatCapability(capabilities.systemdUserScope)}`,
      '',
    ].join('\n');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
  const isCI = process.env.CI === 'true';
  const requireZeroSkips = process.env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS === '1';
  if (code === 0 && !Number.isInteger(testSummary.testCount))
    process.stderr.write('Test runner summary was missing; refusing success\n');
  else if (code === 0 && testSummary.testCount === 0)
    process.stderr.write('Test runner ran zero tests; refusing success\n');
  if (
    code === 0 &&
    isCI &&
    (testSummary.skippedCount !== isolationSkipCount ||
      testSummary.todoCount !== 0)
  )
    process.stderr.write(
      `CI test policy failed: TAP reports ${testSummary.skippedCount ?? 'unknown'} skipped, ${isolationSkipCount} approved isolation skips, and ${testSummary.todoCount ?? 'unknown'} todo tests\n`,
    );
  if (code === 0 && requireZeroSkips && isolationSkipCount > 0)
    process.stderr.write(
      `gate:local requires zero isolation skips; observed ${isolationSkipCount}\n`,
    );
  const exitCode = forwardedSignal
    ? forwardedSignal === 'SIGINT'
      ? 130
      : 143
    : testSuiteExitCode(code ?? 1, testSummary, requireZeroSkips, isCI);
  process.exitCode = exitCode;
});
