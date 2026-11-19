import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  exitHostLoadFlake,
  hostLoadFlake,
  timeoutOnly,
} from '../../src/ci/test-failures.ts';
import { contractVerification } from '../../src/cli/lane-run/delivery.ts';
import { exitNoDelivery } from '../../src/cli/lane-run/result.ts';

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

test('a passing final check that rewrote tracked files has the rewrite committed, not left dirty', () => {
  const { dir, log } = check([''], [0]);
  const sh = (...a: string[]) =>
    execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  sh('init', '-q');
  sh('config', 'user.email', 'a@b.c');
  sh('config', 'user.name', 'n');
  writeFileSync(join(dir, 'x.ts'), 'a  =1\n');
  writeFileSync(join(dir, '.gitignore'), 'count\ncheck.mjs\ncheck.log\n');
  sh('add', 'x.ts', '.gitignore', 'krn.json');
  sh('commit', '-q', '-m', 'base');
  writeFileSync(
    join(dir, 'check.mjs'),
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('x.ts', 'a = 1\\n');\n",
  );
  const result = contractVerification(dir, log);
  assert.ok(result !== undefined && 'verified' in result);
  assert.equal(sh('status', '--porcelain').trim(), '');
  assert.match(sh('log', '-1', '--format=%s'), /^style: /u);
});
