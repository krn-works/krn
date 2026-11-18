import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { waitForQuietHost } from '../../src/ci/host-load.ts';
import {
  exitHostLoadFlake,
  hostLoadFlake,
  timeoutOnly,
} from '../../src/ci/test-failures.ts';
import { contractVerification } from '../../src/cli/lane-run/delivery.ts';
import { exitNoDelivery } from '../../src/cli/lane-run/result.ts';
import { settledRun } from '../../src/cli/lane-run/test-output.ts';

const timedOut = (...files: string[]) =>
  files
    .map(
      (file) =>
        ` FAIL  ${file} > slow case\nError: Test timed out in 5000ms.\n`,
    )
    .join('');
const asserted = (file: string) =>
  ` FAIL  ${file} > case\nAssertionError: expected 1 to be 2\n`;

test('the flake exit is its own code, not 74 or 65', () => {
  assert.equal(exitHostLoadFlake, 78);
  assert.notEqual(exitHostLoadFlake, exitNoDelivery);
});

test('timeouts on different files in a run and its rerun are a host-load flake', () => {
  assert.equal(
    hostLoadFlake(
      timedOut('test/a.test.ts', 'test/b.test.ts'),
      timedOut('test/b.test.ts', 'test/c.test.ts'),
    ),
    true,
  );
  // The same file timing out twice is a real defect, as is any assertion failure.
  assert.equal(
    hostLoadFlake(timedOut('test/a.test.ts'), timedOut('test/a.test.ts')),
    false,
  );
  assert.equal(
    hostLoadFlake(timedOut('test/a.test.ts'), asserted('test/b.test.ts')),
    false,
  );
  assert.equal(timeoutOnly(asserted('test/a.test.ts')), false);
  assert.equal(
    timeoutOnly(`${timedOut('test/a.test.ts')}${asserted('test/b.test.ts')}`),
    false,
  );
});

test('under a load above the core count the wait sleeps, then returns once the host is quiet', () => {
  const loads = [40, 30, 20, 7];
  const slept: number[] = [];
  const said: string[] = [];
  const waited = waitForQuietHost({
    load: () => loads[0] as number,
    cores: 16,
    pollMs: 500,
    sleep: (ms) => {
      slept.push(ms);
      loads.shift();
    },
    write: (text) => said.push(text),
  });
  assert.deepEqual(slept, [500, 500, 500]);
  assert.equal(waited, 1500);
  assert.equal(said.length, 1);
  assert.match(said[0] as string, /load \(40\.0\) to fall below 16 cores/u);
});

test('a host that stays busy is waited on only up to the bound', () => {
  const slept: number[] = [];
  const waited = waitForQuietHost({
    load: () => 99,
    cores: 16,
    pollMs: 400,
    boundMs: 1000,
    sleep: (ms) => slept.push(ms),
    write: () => {},
  });
  assert.deepEqual(slept, [400, 400, 200]);
  assert.equal(waited, 1000);
  const idle = waitForQuietHost({
    load: () => 3,
    cores: 16,
    sleep: () => assert.fail('an idle host is not waited on'),
  });
  assert.equal(idle, 0);
});

test('settledRun waits for the host before the run and before the rerun', () => {
  const events: string[] = [];
  const results = [
    { status: 1, stdout: timedOut('test/a.test.ts') },
    { status: 0, stdout: '' },
  ];
  const settled = settledRun(
    (command) => {
      events.push(`run ${command}`);
      return results.shift() as { status: number; stdout: string };
    },
    'npm test',
    () => events.push('quiet'),
  );
  assert.equal(settled.run.status, 0);
  assert.deepEqual(events, [
    'quiet',
    'run npm test',
    'quiet',
    "run npm test -- 'test/a.test.ts'",
  ]);
});

// A check command whose output per run comes from a script: run N prints outputs[N].
function check(outputs: string[], statuses: number[]) {
  const dir = mkdtempSync(join(tmpdir(), 'krn-host-load-'));
  const counter = join(dir, 'count');
  writeFileSync(counter, '0');
  writeFileSync(
    join(dir, 'check.mjs'),
    `import { readFileSync, writeFileSync } from 'node:fs';
const outputs = ${JSON.stringify(outputs)};
const statuses = ${JSON.stringify(statuses)};
const n = Number(readFileSync(${JSON.stringify(counter)}, 'utf8'));
writeFileSync(${JSON.stringify(counter)}, String(n + 1));
process.stdout.write(outputs[n] ?? '');
process.exit(statuses[n] ?? 1);
`,
  );
  writeFileSync(
    join(dir, 'krn.json'),
    `${JSON.stringify({ test: 'node check.mjs', tracker: 'krn' })}\n`,
  );
  return { dir, log: join(dir, 'check.log'), counter };
}

test('a final check that times out on different files each run is host load, with the log kept', () => {
  const { dir, log, counter } = check(
    [timedOut('test/a.test.ts'), timedOut('test/b.test.ts')],
    [1, 1],
  );
  const result = contractVerification(dir, log);
  assert.ok(result !== undefined && 'failure' in result);
  assert.equal(result.hostLoad, true);
  assert.match(result.failure, /host load/u);
  assert.equal(readFileSync(counter, 'utf8'), '2');
  assert.match(readFileSync(log, 'utf8'), /test\/b\.test\.ts/u);
});

test('a final check that fails an assertion twice is not host load', () => {
  const { dir, log } = check(
    [asserted('test/a.test.ts'), asserted('test/b.test.ts')],
    [1, 1],
  );
  const result = contractVerification(dir, log);
  assert.ok(result !== undefined && 'failure' in result);
  assert.equal(result.hostLoad, undefined);
});

test('a final check that times out once and passes on the rerun is flaky, not red', () => {
  const { dir, log } = check([timedOut('test/a.test.ts'), ''], [1, 0]);
  const result = contractVerification(dir, log);
  assert.ok(result !== undefined && 'verified' in result);
  assert.deepEqual(result.flaky, ['test/a.test.ts']);
});
