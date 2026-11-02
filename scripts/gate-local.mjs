import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  selectIsolationTestFiles as discoverIsolationTestFiles,
  postGateStatusWhenClean,
} from './isolation-gate.mjs';
import { TEST_FILE_GLOB } from './test-suite.mjs';
import { validateTestSummary } from './test-summary-policy.mjs';

const ghPath = process.env.KRN_GH_BIN ?? 'gh';
const summaryPrefix = 'KRN_TEST_SUMMARY_JSON=';
export const statusRetryBackoffsMs = Object.freeze([2_000, 8_000]);
const gitContextKeys = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
];

function readHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || 'Unable to read HEAD\n');
    return undefined;
  }
  return result.stdout.trim();
}

function requireCleanTree(phase) {
  const result = spawnSync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    process.stderr.write(
      result.stderr || `Unable to inspect Git state ${phase}\n`,
    );
    return false;
  }
  if (result.stdout.trim().length > 0) {
    process.stderr.write(
      `Working tree is dirty ${phase}; refusing gate publication\n`,
    );
    return false;
  }
  return true;
}

export function selectIsolationTestFiles(root = process.cwd()) {
  return discoverIsolationTestFiles(root, TEST_FILE_GLOB);
}

function runNpm(args, strict = false) {
  return new Promise((resolve) => {
    let stdout = '';
    const env = { ...process.env };
    if (strict) env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS = '1';
    else delete env.KRN_REQUIRE_ZERO_ISOLATION_SKIPS;
    const child = spawn('npm', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr
      .setEncoding('utf8')
      .on('data', (chunk) => process.stderr.write(chunk));
    child.once('error', (error) => {
      process.stderr.write(
        `Unable to start npm ${args.join(' ')}: ${error.message}\n`,
      );
      resolve({ exitCode: 1, output: stdout });
    });
    child.once('close', (code) =>
      resolve({ exitCode: code ?? 1, output: stdout }),
    );
  });
}

function lastStructuredSummary(output) {
  const lines = output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(summaryPrefix));
  if (lines.length === 0) return { error: 'structured summary is missing' };
  try {
    const summary = JSON.parse(lines.at(-1).slice(summaryPrefix.length));
    const validation = validateTestSummary(summary);
    if (!validation.ok)
      return {
        error: `structured summary rejected: ${validation.errors.join('; ')}`,
      };
    return { summary };
  } catch (error) {
    return { error: `structured summary is malformed: ${error.message}` };
  }
}

function lastIsolationSkipCount(output) {
  const matches = [
    ...output.matchAll(/Isolation-dependent tests skipped: (\d+)/gu),
  ];
  return Number(matches.at(-1)?.[1] ?? Number.NaN);
}

function isTransientStatusFailure(result) {
  if (result.status === null || result.status === 0) return false;
  const stderr = result.stderr ?? '';
  if (/\bHTTP(?:\/\d+(?:\.\d+)?)?\s+4\d{2}\b/iu.test(stderr)) return false;
  return (
    /\bnetwork\b|\btimeout\b|\btimed out\b|\bconnection (?:reset|refused)\b|\bi\/o timeout\b|\beof\b|\bsecondary rate limit\b/iu.test(
      stderr,
    ) || /\bHTTP(?:\/\d+(?:\.\d+)?)?\s+5\d{2}\b/iu.test(stderr)
  );
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function main({ waitForRetry = wait } = {}) {
  for (const key of gitContextKeys) delete process.env[key];

  const head = readHead();
  if (!head) return 1;
  if (!requireCleanTree('before the gate')) return 1;

  const preflight = await runNpm(['run', 'preflight']);
  if (preflight.exitCode !== 0) return preflight.exitCode;

  let files;
  try {
    files = selectIsolationTestFiles();
    if (files.length === 0) throw new Error('no isolation test files selected');
  } catch (error) {
    process.stderr.write(
      `Unable to select isolation tests: ${error.message}\n`,
    );
    return 1;
  }
  const gate = await runNpm(['test', '--', ...files], true);
  const finalHead = readHead();
  const cleanAfterGate = requireCleanTree('after the gate');
  if (!finalHead || finalHead !== head) {
    process.stderr.write(
      'HEAD changed during the local gate; refusing to publish status\n',
    );
    return 1;
  }
  if (!cleanAfterGate) return 1;

  const isolationSkipCount = lastIsolationSkipCount(gate.output);
  const structured = lastStructuredSummary(gate.output);
  if (structured.error) {
    process.stderr.write(
      `Gate summary was missing or invalid; refusing to publish status: ${structured.error}\n`,
    );
    return 1;
  }
  if (!Number.isInteger(isolationSkipCount)) {
    process.stderr.write(
      'Isolation summary was missing; refusing to publish status\n',
    );
    return 1;
  }

  const testCount = structured.summary.counts.tests;
  const description = `Gate passed: ${testCount} tests, 0 isolation skips`;
  const posted = await postGateStatusWhenClean({
    exitCode: gate.exitCode,
    skipCount: isolationSkipCount,
    post: async () => {
      const args = [
        'api',
        `repos/krn-works/krn/statuses/${head}`,
        '-f',
        'state=success',
        '-f',
        'context=krn/gate-local',
        '-f',
        `description=${description}`,
      ];
      for (let attempt = 0; ; attempt += 1) {
        const result = spawnSync(ghPath, args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (result.status === 0) break;

        const backoff = statusRetryBackoffsMs[attempt];
        if (!isTransientStatusFailure(result) || backoff === undefined) {
          process.stderr.write(
            result.stderr || 'Unable to post gate-local status\n',
          );
          throw new Error('Unable to post gate-local status');
        }
        await waitForRetry(backoff);
      }
      process.stdout.write(
        `Published krn/gate-local success for ${head}: ${description}\n`,
      );
    },
  });
  if (!posted) {
    process.stderr.write(
      `gate-local did not pass cleanly (exit=${gate.exitCode}, isolation skips=${isolationSkipCount}); no status posted\n`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = await main();
