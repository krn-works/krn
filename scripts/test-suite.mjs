import { spawn } from 'node:child_process';
import { globSync, realpathSync, statSync } from 'node:fs';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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
import { summarizeTestEvents } from './test-summary-policy.mjs';

export const TEST_FILE_GLOB = 'test/**/*.test.{ts,js,mjs,cjs}';
const eventReporter = fileURLToPath(
  new URL('./test-events-reporter.mjs', import.meta.url),
);

function defaultTestFiles() {
  const testRoot = realpathSync(join(process.cwd(), 'test'));
  const files = [];
  for (const match of globSync(TEST_FILE_GLOB, { cwd: process.cwd() })) {
    const path = resolve(process.cwd(), match);
    if (!statSync(path).isFile()) continue;
    const resolved = realpathSync(path);
    const fromTestRoot = relative(testRoot, resolved);
    if (
      isAbsolute(fromTestRoot) ||
      fromTestRoot === '..' ||
      fromTestRoot.startsWith(`..${sep}`) ||
      fromTestRoot.length === 0
    )
      throw new Error(
        `test discovery resolved outside project test root: ${resolved}`,
      );
    files.push(resolved);
  }
  return [...new Set(files)].sort();
}

function strictTestFiles(args) {
  if (args.length === 0) return defaultTestFiles();
  const files = args.map((argument) => {
    if (argument.startsWith('-'))
      throw new Error(
        `strict test mode accepts file paths only, not ${argument}`,
      );
    const file = resolve(process.cwd(), argument);
    if (!statSync(file).isFile())
      throw new Error(`strict test argument is not a file: ${argument}`);
    return realpathSync(file);
  });
  return [...new Set(files)].sort();
}

async function assertPinnedNode() {
  const pinned = (
    await readFile(join(process.cwd(), '.node-version'), 'utf8')
  ).trim();
  if (!/^v?\d+\.\d+\.\d+$/u.test(pinned))
    throw new Error('strict test mode requires a valid .node-version pin');
  if (pinned.replace(/^v/u, '') !== process.version.slice(1))
    throw new Error(
      `strict test mode requires Node ${pinned}; running ${process.version}`,
    );
}

function discoveryFiles() {
  return defaultTestFiles();
}

function childEnvironment(capabilities, strict, eventFile) {
  const env = {
    ...process.env,
    KRN_ISOLATION_CAPABILITIES: JSON.stringify(capabilities),
  };
  if (strict) {
    delete env.NODE_OPTIONS;
    delete env.KRN_SCOPE_PROBE;
    delete env.KRN_TEST_EVENT_FILE;
    for (const key of Object.keys(env)) {
      if (key.startsWith('NODE_TEST_')) delete env[key];
    }
    env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS = '1';
    env.KRN_TEST_EVENT_FILE = eventFile;
  }
  return env;
}

async function readRecordedEvents(path) {
  try {
    const contents = await readFile(path, 'utf8');
    if (contents.length === 0) return [];
    return contents
      .split(/\r?\n/u)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function printStrictSummary(result) {
  process.stdout.write(
    `KRN_TEST_SUMMARY_JSON=${JSON.stringify(result.summary)}\n`,
  );
}

async function main() {
  const strict = process.env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS === '1';
  const probeRequested = process.env.KRN_SCOPE_PROBE === '1';
  const inheritedTestContext = Boolean(process.env.NODE_TEST_CONTEXT);
  let eventDirectory;
  let expectedFiles = [];
  let structuredSummaryWritten = false;
  let exitCode = 1;

  try {
    if (strict) await assertPinnedNode();

    if (probeRequested && inheritedTestContext) {
      const files = discoveryFiles();
      if (files.length === 0)
        throw new Error('scope probe found no project test files');
      process.stdout.write(`KRN_DISCOVERED=${JSON.stringify(files)}\n`);
      return 0;
    }
    if (probeRequested && strict)
      throw new Error(
        'strict scope probe requires inherited NODE_TEST_CONTEXT',
      );

    const requestedFiles = process.argv.slice(2);
    let runnerFiles;
    if (strict) {
      expectedFiles = strictTestFiles(requestedFiles);
      if (expectedFiles.length === 0)
        throw new Error('strict test selection contains no files');
      runnerFiles = expectedFiles;
    } else {
      runnerFiles =
        requestedFiles.length > 0 ? requestedFiles : [TEST_FILE_GLOB];
    }

    const inheritedCapabilities =
      probeRequested && process.env.KRN_ISOLATION_CAPABILITIES
        ? JSON.parse(process.env.KRN_ISOLATION_CAPABILITIES)
        : undefined;
    const capabilities = inheritedCapabilities ?? probeIsolationCapabilities();
    if (!inheritedCapabilities)
      process.stdout.write(`${formatIsolationProbe(capabilities)}\n`);

    let eventFile;
    if (strict) {
      const stateDirectory = join(process.cwd(), '.krn/tmp');
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      eventDirectory = await mkdtemp(
        join(stateDirectory, 'strict-test-events-'),
      );
      eventFile = join(eventDirectory, 'events.jsonl');
      await writeFile(eventFile, '', { mode: 0o600 });
    }

    const runnerArgs = [
      '--test',
      '--test-concurrency=1',
      '--test-reporter=tap',
    ];
    if (strict) {
      runnerArgs.push(
        '--test-reporter-destination=stdout',
        `--test-reporter=${eventReporter}`,
        '--test-reporter-destination=stderr',
      );
    }
    runnerArgs.push(...runnerFiles);

    const child = spawn(process.execPath, runnerArgs, {
      detached: process.platform !== 'win32',
      env: childEnvironment(capabilities, strict, eventFile),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
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

    const runner = await new Promise((resolveRunner) => {
      let settled = false;
      child.once('error', (error) => {
        process.stderr.write(
          `Unable to start Node test runner: ${error.message}\n`,
        );
        if (!settled) {
          settled = true;
          resolveRunner({ code: 1 });
        }
      });
      child.once('close', (code) => {
        if (!settled) {
          settled = true;
          resolveRunner({ code: code ?? 1 });
        }
      });
    });

    const skipCount = countIsolationSkips(stdout);
    const legacySummary = isolationSummary(skipCount);
    const testCount = Number(stdout.match(/^# tests (\d+)$/mu)?.[1] ?? 0);
    process.stdout.write(`${legacySummary}\n`);
    const gateExitCode = forwardedSignal
      ? forwardedSignal === 'SIGINT'
        ? 130
        : 143
      : testSuiteExitCode(
          runner.code,
          skipCount,
          process.env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS === '1',
        );

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
        `- ${legacySummary}`,
        `- bwrap: ${formatCapability(capabilities.bwrap)}`,
        `- systemd user scopes: ${formatCapability(capabilities.systemdUserScope)}`,
        '',
      ].join('\n');
      await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
    }

    if (strict) {
      const events = await readRecordedEvents(eventFile);
      const result = summarizeTestEvents(events, expectedFiles, gateExitCode);
      if (!result.ok)
        process.stderr.write(
          `Strict test evidence rejected: ${result.errors.join('; ')}\n`,
        );
      printStrictSummary(result);
      structuredSummaryWritten = true;
      exitCode = forwardedSignal ? gateExitCode : result.ok ? 0 : 1;
    } else {
      exitCode = gateExitCode;
    }
    if (process.env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS === '1' && skipCount > 0)
      process.stderr.write(
        `gate:local requires zero isolation skips; observed ${skipCount}\n`,
      );
  } catch (error) {
    process.stderr.write(`Test suite wrapper failed: ${error.message}\n`);
    if (strict && !structuredSummaryWritten) {
      const result = summarizeTestEvents([], expectedFiles, 1);
      printStrictSummary(result);
      structuredSummaryWritten = true;
    }
    exitCode = 1;
  } finally {
    if (eventDirectory) {
      try {
        await rm(eventDirectory, { recursive: true, force: true });
      } catch (error) {
        process.stderr.write(
          `Unable to clean owned test event state: ${error.message}\n`,
        );
        exitCode = 1;
      }
    }
  }
  return exitCode;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await main();
