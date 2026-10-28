import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { execute, MAX_CHECK_OUTPUT_BYTES } from '../../src/verdict/sandbox.ts';
import {
  conditionTimeoutFor,
  waitForCondition,
} from '../helpers/condition-wait.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

const MIB = 1024 * 1024;
const EXPECTED_TMPDIR_SIZE_BYTES = 256 * MIB;
const PRIVATE_RUN_SCRATCH = join(
  process.cwd(),
  '.krn',
  'runs',
  'claude',
  'check-temp-capacity',
  'scratch',
);

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function makeFixture(root: string): string {
  cpSync(join(process.cwd(), 'src'), join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'test', 'task'), { recursive: true });
  cpSync(
    join(process.cwd(), 'test', 'task', 'task.test.ts'),
    join(root, 'test', 'task', 'task.test.ts'),
  );
  writeFileSync(
    join(root, 'package.json'),
    '{"private":true,"type":"module"}\n',
  );
  writeFileSync(
    join(root, 'measure-tmp.mjs'),
    `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
const directory = tmpdir();
const original = fs.writeFileSync;
let peak = 0;
function sample() {
  const state = fs.statfsSync(directory);
  peak = Math.max(peak, (state.blocks - state.bfree) * state.bsize);
}
fs.writeFileSync = (...args) => {
  const result = original(...args);
  if (typeof args[0] === 'string' && args[0].startsWith(directory + sep)) sample();
  return result;
};
syncBuiltinESMExports();
process.on('exit', () => {
  try { original(join(directory, 'peak-' + process.pid + '.json'), String(peak)); } catch {}
});
`,
  );
  writeFileSync(
    join(root, 'capacity-check.mjs'),
    `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, statfsSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const hostSentinel = process.argv[2];
const hostProbeName = process.argv[3];
const expectedCapacity = Number(process.argv[4]);
const temp = tmpdir();
const home = process.env.HOME;
assert.equal(process.env.TMPDIR, temp);
assert.equal(home, '/tmp');
assert.equal(existsSync(hostSentinel), false, 'host run scratch is visible inside the sandbox');

function writeBytes(path, bytes) {
  const descriptor = openSync(path, 'wx', 0o600);
  const chunk = Buffer.alloc(1024 * 1024, 0x5a);
  let remaining = bytes;
  try {
    while (remaining > 0) {
      const written = writeSync(descriptor, chunk, 0, Math.min(chunk.length, remaining));
      assert.ok(written > 0);
      remaining -= written;
    }
  } finally {
    closeSync(descriptor);
  }
}

const measurePath = join(process.cwd(), 'measure-tmp.mjs');
const stress = spawnSync(process.execPath, [
  '--test',
  '--test-name-pattern=20,000 task dependency chain',
  'test/task/task.test.ts',
], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: { ...process.env, NODE_OPTIONS: '--import=' + measurePath },
  timeout: 100_000,
});
const peakFiles = readdirSync(temp).filter((name) => /^peak-[0-9]+\\.json$/u.test(name));
assert.ok(peakFiles.length > 0, 'the task stress test did not report tmpfs usage');
const taskPeakBytes = Math.max(...peakFiles.map((name) => Number(readFileSync(join(temp, name), 'utf8'))));
for (const name of peakFiles) unlinkSync(join(temp, name));
assert.equal(stress.status, 0, '20,000 task chain failed inside the isolated check\\n' + stress.stdout + stress.stderr);
assert.ok(taskPeakBytes > 64 * 1024 * 1024, 'the task stress test did not exceed the old cap');
assert.ok(taskPeakBytes <= 128 * 1024 * 1024, 'the task stress test peak exceeded 128 MiB');
assert.equal(temp, '/krn-check-tmp');
const tempState = statfsSync(temp);
assert.equal(tempState.blocks * tempState.bsize, expectedCapacity);

const largeFile = join(temp, 'single-file-over-old-cap');
writeBytes(largeFile, 65 * 1024 * 1024);
assert.equal(statSync(largeFile).size, 65 * 1024 * 1024);
unlinkSync(largeFile);

const homeFile = join(home, 'home-over-old-cap');
let homeError;
try { writeBytes(homeFile, 65 * 1024 * 1024); } catch (error) { homeError = error; }
finally { rmSync(homeFile, { force: true }); }
assert.equal(homeError?.code, 'ENOSPC', 'HOME must keep its 64 MiB limit');

const mountMarker = join(temp, 'private-mount-marker');
writeFileSync(mountMarker, 'private temp mount');
assert.equal(existsSync(join(process.cwd(), 'private-mount-marker')), false);
writeFileSync(join(home, hostProbeName), 'private home mount');
assert.equal(existsSync(hostSentinel), false);

const overCapacity = join(temp, 'over-capacity');
let capacityError;
try { writeBytes(overCapacity, expectedCapacity + 1024 * 1024); } catch (error) { capacityError = error; }
finally { rmSync(overCapacity, { force: true }); }
assert.equal(capacityError?.code, 'ENOSPC', 'TMPDIR must reject writes past its configured cap');
assert.equal(existsSync(mountMarker), true);
console.log('CAPACITY_REPORT ' + JSON.stringify({
  taskPeakBytes,
  taskPeakMiB: taskPeakBytes / (1024 * 1024),
  tmpdir: temp,
  tmpdirCapacityBytes: expectedCapacity,
  home,
  cases: ['20,000 small files', 'single file above 64 MiB', 'ENOSPC past TMPDIR cap', 'ENOSPC past HOME cap', 'os.tmpdir and TMPDIR use the private mount', 'host paths stay unreachable'],
}));
`,
  );
  writeFileSync(
    join(root, 'concurrent-check.mjs'),
    `import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [label, peer] = process.argv.slice(2);
const temp = tmpdir();
assert.equal(temp, '/krn-check-tmp');
const ownMarker = join(temp, 'marker-' + label);
writeFileSync(ownMarker, label);
writeFileSync(join(process.cwd(), 'started-' + label), 'ready');
const release = join(process.cwd(), 'release-concurrent');
const deadline = performance.now() + 30_000;
while (!existsSync(release)) {
  assert.ok(performance.now() < deadline, 'concurrent peer did not reach the barrier');
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal(readFileSync(ownMarker, 'utf8'), label);
assert.equal(existsSync(join(temp, 'marker-' + peer)), false, 'concurrent checks shared a temp mount');
console.log('CONCURRENT_PRIVATE_TMPDIR ' + label);
`,
  );

  git(root, ['init', '--quiet']);
  git(root, ['config', 'core.hooksPath', '/dev/null']);
  git(root, ['config', 'user.name', 'Sandbox capacity test']);
  git(root, ['config', 'user.email', 'sandbox-capacity@example.invalid']);
  git(root, [
    'add',
    'package.json',
    'src',
    'test',
    'measure-tmp.mjs',
    'capacity-check.mjs',
    'concurrent-check.mjs',
  ]);
  git(root, ['commit', '-qm', 'capacity fixture']);
  return git(root, ['rev-parse', 'HEAD']);
}

function diagnostics(root: string, jobId: string): string {
  const directory = join(root, '.krn', 'runs', 'foreman', jobId, 'diagnostics');
  if (!existsSync(directory)) return '';
  return readdirSync(directory)
    .map((name) => readFileSync(join(directory, name), 'utf8'))
    .join('\n');
}

test('isolated checks use a private bounded TMPDIR while HOME stays capped', {
  timeout: conditionTimeoutFor(2),
}, async (t) => {
  if (
    !requiresIsolation(
      t,
      'isolated checks use a private bounded TMPDIR while HOME stays capped',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;

  assert.equal(MAX_CHECK_OUTPUT_BYTES, 8 * MIB);
  mkdirSync(PRIVATE_RUN_SCRATCH, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(PRIVATE_RUN_SCRATCH, 'sandbox-temp-capacity-'));
  const hostSentinel = join(
    PRIVATE_RUN_SCRATCH,
    `host-only-${randomUUID()}.txt`,
  );
  const hostProbeName = `guest-home-${randomUUID()}.txt`;
  writeFileSync(hostSentinel, 'host-only');
  const jobId = `sandbox-temp-capacity-${randomUUID()}`;

  try {
    const sha = makeFixture(root);
    const job = {
      id: jobId,
      issue: 'sandbox-temp-capacity',
      worktree: root,
      repoRoot: root,
    };
    const capacity = await execute(
      root,
      root,
      job,
      'capacity',
      [
        process.execPath,
        join(root, 'capacity-check.mjs'),
        hostSentinel,
        hostProbeName,
        String(EXPECTED_TMPDIR_SIZE_BYTES),
      ],
      120_000,
      sha,
      undefined,
      sha,
    );
    const capacityOutput = diagnostics(root, jobId);
    assert.equal(
      capacity.exitCode,
      0,
      `isolated capacity check failed with exit ${capacity.exitCode}:\n${capacityOutput}`,
    );
    const reportLine = capacityOutput
      .split(/\r?\n/u)
      .find((line) => line.startsWith('CAPACITY_REPORT '));
    assert.ok(reportLine, capacityOutput);
    const report = JSON.parse(reportLine.slice('CAPACITY_REPORT '.length)) as {
      taskPeakBytes: number;
      taskPeakMiB: number;
      tmpdirCapacityBytes: number;
    };
    assert.ok(report.taskPeakBytes > 64 * MIB);
    assert.ok(report.taskPeakBytes <= 128 * MIB);
    assert.equal(report.tmpdirCapacityBytes, EXPECTED_TMPDIR_SIZE_BYTES);
    t.diagnostic(
      `20,000 task dependency chain peak: ${report.taskPeakBytes} bytes (${report.taskPeakMiB.toFixed(2)} MiB); TMPDIR cap: ${EXPECTED_TMPDIR_SIZE_BYTES} bytes`,
    );
    assert.equal(existsSync(join(root, 'private-mount-marker')), false);
    assert.equal(existsSync(join('/tmp', hostProbeName)), false);
    assert.equal(readFileSync(hostSentinel, 'utf8'), 'host-only');

    const concurrentRuns = ['left', 'right'].map((label) => {
      const peer = label === 'left' ? 'right' : 'left';
      return execute(
        root,
        root,
        job,
        `concurrent-${label}`,
        [process.execPath, join(root, 'concurrent-check.mjs'), label, peer],
        60_000,
        sha,
        undefined,
        sha,
      );
    });
    let barrierError: unknown;
    try {
      await waitForCondition(
        () =>
          ['left', 'right'].every((label) =>
            existsSync(join(root, `started-${label}`)),
          ) || undefined,
        'both concurrent checks to reach the private temp mount',
        30_000,
      );
    } catch (error) {
      barrierError = error;
    }
    writeFileSync(join(root, 'release-concurrent'), 'go');
    const concurrentResults = await Promise.all(concurrentRuns);
    assert.equal(barrierError, undefined, String(barrierError));
    for (const result of concurrentResults)
      assert.equal(
        result.exitCode,
        0,
        `concurrent isolated check failed with exit ${result.exitCode}:\n${diagnostics(root, jobId)}`,
      );
    t.diagnostic('two concurrent checks observed distinct TMPDIR contents');
  } finally {
    rmSync(hostSentinel, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
