import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countIsolationSkips,
  isolationSummary,
  testSuiteExitCode,
} from './isolation-gate.mjs';
import {
  formatIsolationProbe,
  probeIsolationCapabilities,
} from './probe-isolation.mjs';

export const TEST_FILE_GLOB = 'test/**/*.test.{ts,js,mjs,cjs}';

function countSelectedTests(output) {
  const subtests = [...output.matchAll(/^\s*# Subtest: (.+)$/gmu)].map(
    (match) => match[1],
  );
  if (subtests.length === 0)
    return Number(output.match(/^# tests (\d+)$/mu)?.[1] ?? 0);
  return subtests.filter(
    (name) => !/(?:^|[\\/])[^\\/]+\.test\.(?:ts|js|mjs|cjs)$/u.test(name),
  ).length;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
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
  const child = spawn(
    process.execPath,
    [
      '--import',
      fileURLToPath(new URL('../test/helpers/isolation.ts', import.meta.url)),
      '--test',
      '--test-concurrency=1',
      '--test-reporter=tap',
      ...(requestedTestFiles.length > 0
        ? requestedTestFiles
        : [TEST_FILE_GLOB]),
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
    process.stderr.write(
      `Unable to start Node test runner: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
  child.once('close', async (code) => {
    const skipCount = countIsolationSkips(stdout);
    const summary = isolationSummary(skipCount);
    const testCount = countSelectedTests(stdout);
    const skippedCount = Number(stdout.match(/^# skipped (\d+)$/mu)?.[1] ?? 0);
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
    const exitCode = forwardedSignal
      ? forwardedSignal === 'SIGINT'
        ? 130
        : 143
      : testSuiteExitCode(
          code ?? 1,
          skipCount,
          process.env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS === '1',
        );
    const integrityFailures = [];
    if (testCount === 0)
      integrityFailures.push('test suite selected zero tests');
    if (todoCount > 0)
      integrityFailures.push(`test suite reported ${todoCount} todo tests`);
    if (skippedCount !== skipCount)
      integrityFailures.push(
        `runner reported ${skippedCount} skipped tests but ${skipCount} isolation approvals`,
      );
    if (stdout.includes('UNAPPROVED_TEST_SKIP:'))
      integrityFailures.push('test called skip outside requiresIsolation');
    if (process.env.CI === 'true' && integrityFailures.length > 0) {
      for (const failure of integrityFailures)
        process.stderr.write(`gate: ${failure}\n`);
      process.exitCode = 1;
      return;
    }
    if (process.env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS === '1' && skipCount > 0)
      process.stderr.write(
        `gate:local requires zero isolation skips; observed ${skipCount}\n`,
      );
    process.exitCode = exitCode;
  });
}
