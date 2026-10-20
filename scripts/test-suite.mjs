import { spawn } from 'node:child_process';
import { globSync, lstatSync, realpathSync, statSync } from 'node:fs';
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
const isolationGate = fileURLToPath(
  new URL('./isolation-gate.mjs', import.meta.url),
);

function defaultTestFiles() {
  const projectRoot = realpathSync(process.cwd());
  const testRoot = join(projectRoot, 'test');
  const testRootStat = lstatSync(testRoot);
  if (!testRootStat.isDirectory() || testRootStat.isSymbolicLink())
    throw new Error('project test root must be a real directory');
  const files = [];
  for (const match of globSync(TEST_FILE_GLOB, { cwd: projectRoot })) {
    const path = resolve(projectRoot, match);
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

function childEnvironment(capabilities, strict, eventFile) {
  const env = {
    ...process.env,
    KRN_ISOLATION_CAPABILITIES: JSON.stringify(capabilities),
    KRN_ISOLATION_GATE_PRELOAD: '1',
  };
  delete env.KRN_ISOLATION_APPROVAL_TOKEN;
  if (strict) {
    delete env.NODE_OPTIONS;
    delete env.KRN_SCOPE_PROBE;
    delete env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS;
    for (const key of Object.keys(env)) {
      if (key.startsWith('NODE_TEST_')) delete env[key];
    }
    env.KRN_TEST_EVENT_FILE = eventFile;
  }
  return env;
}

async function readRecordedEvents(path) {
  try {
    const contents = await readFile(path, 'utf8');
    if (contents.length === 0) return { events: [] };
    return {
      events: contents
        .split(/\r?\n/u)
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line)),
    };
  } catch (error) {
    return { events: [], error };
  }
}

function printStrictSummary(result) {
  process.stdout.write(
    `KRN_TEST_SUMMARY_JSON=${JSON.stringify(result.summary)}\n`,
  );
}

function signalExit(signal) {
  return signal === 'SIGINT' ? 130 : 143;
}

async function main() {
  const strict = process.env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS === '1';
  const probeRequested = process.env.KRN_SCOPE_PROBE === '1';
  const inheritedTestContext = Boolean(process.env.NODE_TEST_CONTEXT);
  let eventDirectory;
  let expectedFiles = [];
  let structuredSummaryWritten = false;
  let forwardedSignal;
  let child;
  let exitCode = 1;
  const cleanupOwnedEvents = async () => {
    if (!eventDirectory) return undefined;
    try {
      await rm(eventDirectory, { recursive: true, force: true });
      eventDirectory = undefined;
      return undefined;
    } catch (error) {
      return error;
    }
  };
  const forwardSignal = (signal) => {
    if (forwardedSignal) return;
    forwardedSignal = signal;
    const sendSignal = () => {
      if (!child?.pid) return;
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
    if (child?.pid) sendSignal();
    else if (child) child.once('spawn', sendSignal);
  };
  process.once('SIGINT', () => forwardSignal('SIGINT'));
  process.once('SIGTERM', () => forwardSignal('SIGTERM'));

  try {
    if (strict) {
      await assertPinnedNode();
      if (forwardedSignal)
        throw new Error('interrupted before test runner setup');
    }

    if (strict && probeRequested)
      throw new Error('strict test mode refuses KRN_SCOPE_PROBE');
    if (probeRequested && inheritedTestContext) {
      const files = defaultTestFiles();
      if (files.length === 0)
        throw new Error('scope probe found no project test files');
      process.stdout.write(`KRN_DISCOVERED=${JSON.stringify(files)}\n`);
      return 0;
    }

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
      if (forwardedSignal)
        throw new Error('interrupted before test runner setup');
      eventDirectory = await mkdtemp(
        join(stateDirectory, 'strict-test-events-'),
      );
      if (forwardedSignal)
        throw new Error('interrupted before test runner setup');
      eventFile = join(eventDirectory, 'events.jsonl');
      await writeFile(eventFile, '', { mode: 0o600 });
      if (forwardedSignal)
        throw new Error('interrupted before test runner setup');
    }

    const runnerArgs = [
      '--import',
      isolationGate,
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
    if (forwardedSignal)
      throw new Error('interrupted before test runner start');

    child = spawn(process.execPath, runnerArgs, {
      detached: process.platform !== 'win32',
      env: childEnvironment(capabilities, strict, eventFile),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
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
      ? signalExit(forwardedSignal)
      : testSuiteExitCode(runner.code, skipCount, strict);

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
      const recorded = await readRecordedEvents(eventFile);
      const cleanupError = await cleanupOwnedEvents();
      const decisionExitCode = forwardedSignal
        ? signalExit(forwardedSignal)
        : gateExitCode;
      const result = summarizeTestEvents(
        recorded.events,
        expectedFiles,
        decisionExitCode,
      );
      if (recorded.error) {
        result.errors.push(
          `unable to read native test events: ${recorded.error.message}`,
        );
        result.summary.success = false;
        result.ok = false;
      }
      if (cleanupError) {
        result.errors.push(
          `unable to clean owned test event state: ${cleanupError.message}`,
        );
        result.summary.success = false;
        result.ok = false;
      }
      if (!result.ok)
        process.stderr.write(
          `Strict test evidence rejected: ${result.errors.join('; ')}\n`,
        );
      printStrictSummary(result);
      structuredSummaryWritten = true;
      exitCode = forwardedSignal
        ? signalExit(forwardedSignal)
        : result.ok
          ? 0
          : 1;
    } else {
      exitCode = forwardedSignal ? signalExit(forwardedSignal) : gateExitCode;
    }
    if (strict && skipCount > 0)
      process.stderr.write(
        `gate:local requires zero isolation skips; observed ${skipCount}\n`,
      );
  } catch (error) {
    process.stderr.write(`Test suite wrapper failed: ${error.message}\n`);
    if (strict && !structuredSummaryWritten) {
      const cleanupError = await cleanupOwnedEvents();
      const result = summarizeTestEvents(
        [],
        expectedFiles,
        forwardedSignal ? signalExit(forwardedSignal) : 1,
      );
      if (cleanupError) {
        result.errors.push(
          `unable to clean owned test event state: ${cleanupError.message}`,
        );
        result.summary.success = false;
        result.ok = false;
      }
      printStrictSummary(result);
      structuredSummaryWritten = true;
    }
    exitCode = forwardedSignal ? signalExit(forwardedSignal) : 1;
  } finally {
    const cleanupError = await cleanupOwnedEvents();
    if (cleanupError) {
      process.stderr.write(
        `Unable to clean owned test event state: ${cleanupError.message}\n`,
      );
      exitCode = 1;
    }
  }
  return exitCode;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await main();
