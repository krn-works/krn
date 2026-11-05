import { spawn, spawnSync } from 'node:child_process';
import {
  globSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countIsolationSkips,
  isolationCoverage,
  isolationSummary,
  probeGoCapability,
  selectIsolationTestFiles,
  testSuiteExitCode,
} from './isolation-gate.mjs';
import {
  configuredTestShardCount,
  mergeTestShardResults,
  planTestShards,
} from './lib/test-shards.mjs';
import { formatSlowestTests, slowestTests } from './lib/test-timings.mjs';
import {
  formatIsolationProbe,
  probeIsolationCapabilities,
} from './probe-isolation.mjs';

export const TEST_FILE_GLOB = 'test/**/*.test.{ts,js,mjs,cjs}';
const eventReporter = fileURLToPath(
  new URL('./test-events-reporter.mjs', import.meta.url),
);
const isolationGate = fileURLToPath(
  new URL('./isolation-gate.mjs', import.meta.url),
);
const childEnvironmentAllowlist = new Set([
  'CI',
  // Host systemd-scope tests need the host user's runtime and D-Bus endpoints.
  'DBUS_SESSION_BUS_ADDRESS',
  'GITHUB_STEP_SUMMARY',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LOGNAME',
  'NODE_OPTIONS',
  'PATH',
  'SHELL',
  'TERM',
  'USER',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'XDG_STATE_HOME',
]);
const childEnvironmentAllowlistPrefixes = ['KRN_', 'MISE_'];
const childEnvironmentDenylist = new Set([
  'KRN_ISOLATION_APPROVAL_TOKEN',
  'KRN_TEST_SHARDS',
  'KRN_TEST_EVENT_FILE',
]);

function isInside(parent, path) {
  const fromParent = relative(parent, path);
  return (
    fromParent.length > 0 &&
    !isAbsolute(fromParent) &&
    fromParent !== '..' &&
    !fromParent.startsWith(`..${sep}`)
  );
}

function projectTestFiles(projectRoot) {
  const testRoot = join(projectRoot, 'test');
  const testRootStat = lstatSync(testRoot);
  if (!testRootStat.isDirectory() || testRootStat.isSymbolicLink())
    throw new Error('project test root must be a real directory');
  const files = [];
  for (const match of globSync(TEST_FILE_GLOB, { cwd: projectRoot })) {
    const path = resolve(projectRoot, match);
    if (!statSync(path).isFile()) continue;
    const resolved = realpathSync(path);
    if (!isInside(testRoot, resolved))
      throw new Error(
        `test discovery resolved outside project test root: ${resolved}`,
      );
    files.push(resolved);
  }
  return [...new Set(files)].sort();
}

function defaultTestFiles() {
  return projectTestFiles(realpathSync(process.cwd()));
}

const MAX_TEST_ARGUMENT_BYTES = 4096;

// A directory argument selects the files TEST_FILE_GLOB discovers whose real
// path lies inside the directory's real path, the same real paths CI runs, so
// a caller such as preflight never restates CI's test grammar.
export function selectTestFiles(args, projectRoot = process.cwd()) {
  const root = realpathSync(projectRoot);
  if (args.length === 0) return projectTestFiles(root);
  let discovered;
  const files = args.flatMap((argument) => {
    if (Buffer.byteLength(argument, 'utf8') > MAX_TEST_ARGUMENT_BYTES)
      throw new Error(`test argument exceeds ${MAX_TEST_ARGUMENT_BYTES} bytes`);
    const shown = JSON.stringify(argument);
    if (argument.startsWith('-'))
      throw new Error(
        `test selection accepts file or directory paths only, not ${shown}`,
      );
    const path = resolve(root, argument);
    const stat = statSync(path);
    if (stat.isFile()) return [realpathSync(path)];
    if (!stat.isDirectory())
      throw new Error(`test argument is not a file or directory: ${shown}`);
    discovered ??= projectTestFiles(root);
    // An empty argument, the project root or a symlink out of test/ would
    // otherwise widen the selection beyond the directory the caller named.
    const directory = realpathSync(path);
    const testRoot = join(root, 'test');
    if (directory !== testRoot && !isInside(testRoot, directory))
      throw new Error(
        `test directory argument must be the project test root or inside it: ${shown}`,
      );
    const selected = discovered.filter((file) => isInside(directory, file));
    if (selected.length === 0)
      throw new Error(`test directory holds no project test files: ${shown}`);
    return selected;
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

function parentMiseDataDirectory() {
  if (process.env.MISE_DATA_DIR) return process.env.MISE_DATA_DIR;
  const parentHome = process.env.HOME || homedir();
  const parentDataHome =
    process.env.XDG_DATA_HOME || join(parentHome, '.local', 'share');
  return resolve(parentDataHome, 'mise');
}

function parentPnpmStoreDirectory() {
  const configuredStoreDirectory = process.env.pnpm_config_store_dir;
  if (configuredStoreDirectory !== undefined && configuredStoreDirectory !== '')
    return resolve(process.cwd(), configuredStoreDirectory);

  try {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    );
    const manager = manifest?.packageManager;
    if (typeof manager !== 'string' || !/^pnpm@\d+\.\d+\.\d+$/u.test(manager))
      throw new Error('package.json has an invalid packageManager');

    const where = spawnSync('mise', ['where', manager], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: process.env,
      timeout: 15_000,
    });
    const managerDirectory = where.status === 0 ? where.stdout.trim() : '';
    if (!managerDirectory)
      throw new Error(
        where.error?.message ||
          where.stderr.trim() ||
          `mise where ${manager} failed`,
      );

    const pnpm = join(managerDirectory, 'pnpm');
    const result = spawnSync(pnpm, ['store', 'path'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: process.env,
      timeout: 15_000,
    });
    const reportedStoreDirectory =
      result.status === 0 ? result.stdout.trim() : '';
    if (!reportedStoreDirectory)
      throw new Error(
        result.error?.message ||
          result.stderr.trim() ||
          `${manager} store path failed`,
      );
    return resolve(process.cwd(), reportedStoreDirectory);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Warning: unable to resolve the parent pnpm store; shards will not receive pnpm_config_store_dir (${detail})\n`,
    );
    return undefined;
  }
}

function childEnvironment(
  capabilities,
  strict,
  eventFile,
  workerDirectory,
  pnpmStoreDirectory,
) {
  const home = join(workerDirectory, 'home');
  const temp = join(workerDirectory, 'tmp');
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          (childEnvironmentAllowlist.has(key) ||
            childEnvironmentAllowlistPrefixes.some((prefix) =>
              key.startsWith(prefix),
            )) &&
          !childEnvironmentDenylist.has(key),
      ),
    ),
    HOME: home,
    TMP: temp,
    TEMP: temp,
    TMPDIR: temp,
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    MISE_DATA_DIR: parentMiseDataDirectory(),
    // Node creates this best-effort cache. Keep it outside disposable shard
    // TMPDIRs so subsequent runners and inherited child nodes can reuse it.
    NODE_COMPILE_CACHE:
      process.env.NODE_COMPILE_CACHE ??
      join(process.cwd(), '.krn/tmp/node-compile-cache'),
    KRN_TEST_EVENT_FILE: eventFile,
    KRN_ISOLATION_CAPABILITIES: JSON.stringify(capabilities),
    KRN_ISOLATION_GATE_PRELOAD: '1',
  };
  if (pnpmStoreDirectory !== undefined)
    env.pnpm_config_store_dir = pnpmStoreDirectory;
  if (strict) {
    delete env.NODE_OPTIONS;
    delete env.KRN_SCOPE_PROBE;
    delete env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS;
    for (const key of Object.keys(env)) {
      if (key.startsWith('NODE_TEST_')) delete env[key];
    }
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

async function runTestGroup({
  files,
  runnerArguments = files,
  index,
  strict,
  capabilities,
  stateDirectory,
  runDirectory,
  pnpmStoreDirectory,
  activeChildren,
  getForwardedSignal,
}) {
  let eventDirectory;
  let eventFile;
  let child;
  let stdout = '';
  let stderr = '';
  let setupError;
  let runnerExitCode = 1;
  let events = [];
  const workerDirectory = join(
    runDirectory,
    `worker-${String(index + 1).padStart(3, '0')}`,
  );

  try {
    await mkdir(workerDirectory, { recursive: true, mode: 0o700 });
    await mkdir(join(workerDirectory, 'home'), {
      recursive: true,
      mode: 0o700,
    });
    const workerTmpDirectory = join(workerDirectory, 'tmp');
    await mkdir(workerTmpDirectory, { recursive: true, mode: 0o700 });
    // Keep temporary fixture scripts from inheriting the repository's
    // "type": "module" package scope. An unspecified type lets Node infer
    // each extensionless fixture's format from its syntax.
    await writeFile(
      join(workerTmpDirectory, 'package.json'),
      '{"private":true}\n',
      { mode: 0o600 },
    );
    eventDirectory = await mkdtemp(
      join(stateDirectory, strict ? 'strict-test-events-' : 'test-events-'),
    );
    eventFile = join(eventDirectory, 'events.jsonl');
    await writeFile(eventFile, '', { mode: 0o600 });
    if (getForwardedSignal())
      throw new Error('interrupted before test runner start');

    const runnerArgs = [
      '--import',
      isolationGate,
      '--test',
      '--test-concurrency=1',
      '--test-reporter=tap',
      '--test-reporter-destination=stdout',
      `--test-reporter=${eventReporter}`,
      '--test-reporter-destination=stderr',
    ];
    runnerArgs.push(...runnerArguments);
    child = spawn(process.execPath, runnerArgs, {
      detached: process.platform !== 'win32',
      env: childEnvironment(
        capabilities,
        strict,
        eventFile,
        workerDirectory,
        pnpmStoreDirectory,
      ),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChildren.add(child);
    child.once('spawn', () => {
      const signal = getForwardedSignal();
      if (signal) {
        try {
          if (process.platform === 'win32') child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch (error) {
          if (error?.code !== 'ESRCH')
            stderr += `Unable to forward ${signal} to test process group: ${error.message}\n`;
        }
      }
    });
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });

    runnerExitCode = await new Promise((resolveRunner) => {
      let settled = false;
      child.once('error', (error) => {
        stderr += `Unable to start Node test runner: ${error.message}\n`;
        if (!settled) {
          settled = true;
          resolveRunner(1);
        }
      });
      child.once('close', (code) => {
        activeChildren.delete(child);
        if (!settled) {
          settled = true;
          resolveRunner(code ?? 1);
        }
      });
    });
    const signal = getForwardedSignal();
    if (signal) runnerExitCode = signalExit(signal);

    if (eventFile) {
      const recorded = await readRecordedEvents(eventFile);
      events = recorded.events;
      if (recorded.error)
        setupError = `unable to read native test events: ${recorded.error.message}`;
    }
  } catch (error) {
    setupError = error.message;
    const signal = getForwardedSignal();
    runnerExitCode = signal ? signalExit(signal) : 1;
  } finally {
    if (child && activeChildren.has(child) && child.exitCode !== null)
      activeChildren.delete(child);
    if (eventDirectory) {
      try {
        await rm(eventDirectory, { recursive: true, force: true });
      } catch (error) {
        setupError = [
          setupError,
          `unable to clean event state: ${error.message}`,
        ]
          .filter(Boolean)
          .join('; ');
      }
    }
  }

  const tapCounts = [...stdout.matchAll(/^# tests (\d+)$/gmu)];
  const nativeTestCount =
    tapCounts.length === 1 ? Number(tapCounts[0][1]) : undefined;
  if (strict && nativeTestCount === undefined)
    setupError = [setupError, 'native TAP summary is missing or duplicated']
      .filter(Boolean)
      .join('; ');

  return {
    events,
    runnerExitCode,
    nativeTestCount,
    ...(setupError ? { error: setupError } : {}),
    stdout,
    stderr,
  };
}

function defaultCapabilities() {
  const inherited =
    process.env.KRN_SCOPE_PROBE === '1' &&
    process.env.KRN_ISOLATION_CAPABILITIES
      ? JSON.parse(process.env.KRN_ISOLATION_CAPABILITIES)
      : undefined;
  const capabilities = {
    ...(inherited ?? probeIsolationCapabilities()),
    go: inherited?.go ?? probeGoCapability(),
  };
  if (!inherited)
    process.stdout.write(
      `${formatIsolationProbe(capabilities)}; Go toolchain=${capabilities.go.available ? 'available' : 'unavailable'}\n`,
    );
  return capabilities;
}

async function main() {
  const strict = process.env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS === '1';
  const probeRequested = process.env.KRN_SCOPE_PROBE === '1';
  const inheritedTestContext = Boolean(process.env.NODE_TEST_CONTEXT);
  const activeChildren = new Set();
  let runDirectory;
  let stateDirectory;
  let expectedFiles = [];
  let structuredSummaryWritten = false;
  let timingsWritten = false;
  let forwardedSignal;
  let exitCode = 1;
  const forwardSignal = (signal) => {
    if (forwardedSignal) return;
    forwardedSignal = signal;
    for (const child of activeChildren) {
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
    }
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
    let runnerArguments;
    if (strict) {
      expectedFiles = selectTestFiles(requestedFiles);
      if (expectedFiles.length === 0)
        throw new Error('strict test selection contains no files');
      runnerArguments = expectedFiles;
    } else if (
      requestedFiles.some((argument) => /^(?:-|.*[*?{}])/u.test(argument))
    ) {
      runnerArguments = requestedFiles;
    } else {
      expectedFiles = selectTestFiles(requestedFiles);
      if (expectedFiles.length === 0)
        throw new Error('test selection contains no files');
      runnerArguments = expectedFiles;
    }

    const capabilities = defaultCapabilities();
    stateDirectory = join(process.cwd(), '.krn/tmp');
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    runDirectory = await mkdtemp(join(stateDirectory, 'test-suite-run-'));

    let groups;
    if (expectedFiles.length === 0) {
      groups = [{ files: [], runnerArguments }];
    } else {
      const requestedShards = configuredTestShardCount(
        process.env.KRN_TEST_SHARDS,
      );
      const plan = planTestShards(expectedFiles, requestedShards);
      process.stdout.write(
        `Test shard plan: K=${requestedShards}; ${requestedShards === 1 ? 'serial group=1' : `parallel groups=${plan.shards.length}`}; final serial files=${plan.serialFiles.length}\n`,
      );
      if (requestedShards === 1) {
        const serialRun = [...plan.shards.flat(), ...plan.serialFiles];
        groups = serialRun.length > 0 ? [{ files: serialRun }] : [];
      } else {
        groups = plan.shards.map((files) => ({ files }));
        if (plan.serialFiles.length > 0)
          groups.push({ files: plan.serialFiles, finalSerial: true });
      }
    }

    let results = [];
    if (groups.length > 0) {
      const pnpmStoreDirectory = parentPnpmStoreDirectory();
      const parallelCount = groups.at(-1)?.finalSerial
        ? groups.length - 1
        : groups.length;
      const parallelGroups = groups.slice(0, parallelCount);
      const serialGroups = groups.slice(parallelCount);
      results = await Promise.all(
        parallelGroups.map((group, index) =>
          runTestGroup({
            ...group,
            index,
            strict,
            capabilities,
            stateDirectory,
            runDirectory,
            pnpmStoreDirectory,
            activeChildren,
            getForwardedSignal: () => forwardedSignal,
          }),
        ),
      );
      if (!forwardedSignal) {
        for (const [serialIndex, group] of serialGroups.entries()) {
          const result = await runTestGroup({
            ...group,
            index: parallelGroups.length + serialIndex,
            strict,
            capabilities,
            stateDirectory,
            runDirectory,
            pnpmStoreDirectory,
            activeChildren,
            getForwardedSignal: () => forwardedSignal,
          });
          results.push(result);
        }
      }
    }

    let cleanupError;
    try {
      await rm(runDirectory, { recursive: true, force: true });
      runDirectory = undefined;
    } catch (error) {
      cleanupError = `unable to clean shard state: ${error.message}`;
    }

    let stdout = '';
    for (const result of results) {
      stdout += result.stdout;
      process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    const skipCount = countIsolationSkips(stdout);
    const testCount = results.reduce(
      (total, result) => total + (result.nativeTestCount ?? 0),
      0,
    );
    process.stdout.write(`# tests ${testCount}\n`);
    const legacySummary = isolationSummary(skipCount);
    const timings = formatSlowestTests(
      slowestTests(results.flatMap((result) => result.events)),
    );
    process.stdout.write(timings);
    timingsWritten = true;
    process.stdout.write(`${legacySummary}\n`);
    if (cleanupError) process.stderr.write(`${cleanupError}\n`);

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
        `- Go toolchain: ${formatCapability(capabilities.go)}`,
        `- bwrap: ${formatCapability(capabilities.bwrap)}`,
        `- systemd user scopes: ${formatCapability(capabilities.systemdUserScope)}`,
        '',
        timings,
      ].join('\n');
      await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
    }

    const gateExitCode = forwardedSignal
      ? signalExit(forwardedSignal)
      : results.every((result) => result.runnerExitCode === 0) && !cleanupError
        ? 0
        : 1;

    if (strict) {
      const result = mergeTestShardResults(results, expectedFiles, {
        expectedTestCount: testCount,
      });
      if (cleanupError) {
        result.errors.push(cleanupError);
        result.summary.success = false;
        result.ok = false;
      }
      let coverageLine;
      if (requestedFiles.length === 0) {
        let coverage;
        try {
          coverage = isolationCoverage(
            result.summary.files,
            selectIsolationTestFiles(process.cwd(), TEST_FILE_GLOB),
            process.cwd(),
          );
        } catch (error) {
          coverage = {
            ok: false,
            errors: [`isolation selection failed: ${error.message}`],
          };
        }
        if (coverage.ok) coverageLine = coverage.line;
        else {
          result.errors.push(...coverage.errors);
          result.summary.success = false;
          result.ok = false;
        }
      }
      if (!result.ok)
        process.stderr.write(
          `Strict test evidence rejected: ${result.errors.join('; ')}\n`,
        );
      printStrictSummary(result);
      if (coverageLine) process.stderr.write(`${coverageLine}\n`);
      structuredSummaryWritten = true;
      exitCode = forwardedSignal
        ? signalExit(forwardedSignal)
        : result.ok && testSuiteExitCode(gateExitCode, skipCount, true) === 0
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
    if (!timingsWritten) process.stdout.write(formatSlowestTests([]));
    if (runDirectory) {
      try {
        await rm(runDirectory, { recursive: true, force: true });
        runDirectory = undefined;
      } catch (cleanupError) {
        process.stderr.write(
          `Unable to clean shard state: ${cleanupError.message}\n`,
        );
      }
    }
    if (strict && !structuredSummaryWritten) {
      const result = mergeTestShardResults([], expectedFiles);
      result.errors.push(error.message);
      result.summary.success = false;
      result.ok = false;
      printStrictSummary(result);
      structuredSummaryWritten = true;
    }
    exitCode = forwardedSignal ? signalExit(forwardedSignal) : 1;
  } finally {
    if (runDirectory) {
      try {
        await rm(runDirectory, { recursive: true, force: true });
      } catch (error) {
        process.stderr.write(`Unable to clean shard state: ${error.message}\n`);
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
