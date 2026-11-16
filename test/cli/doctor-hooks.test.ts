import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  hooksReport,
  percentile,
  toolCallTimes,
} from '../../src/cli/doctor-hooks.ts';

const krn = fileURLToPath(new URL('../../bin/krn', import.meta.url));

test('percentiles pick the nearest rank', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.ok(Number.isNaN(percentile([], 0.5)));
});

test('only tool-call events of the timing log count, and the budget decides the verdict', () => {
  const log = [
    '{"event":"pre-tool","tool":"Bash","ms":30,"cpu":20,"code":0,"routes":[]}',
    '{"event":"stop","ms":900,"cpu":800,"code":0,"routes":[]}',
    '{"event":"post-tool","ms":50,"cpu":40,"code":0,"routes":[]}',
  ].join('\n');
  const times = toolCallTimes(log);
  assert.deepEqual(times.cpu, [20, 40]);
  assert.equal(hooksReport(times).exitCode, 0);
  assert.equal(hooksReport({ cpu: [80, 90], wall: [80, 90] }).exitCode, 1);
  assert.equal(hooksReport({ cpu: [10, 200], wall: [10, 200] }).exitCode, 1);
});

test('krn doctor --hooks measures the real hook entry and prints one verdict line', () => {
  const run = spawnSync(krn, ['doctor', '--hooks'], { encoding: 'utf8' });
  assert.match(
    run.stdout,
    /^hooks: tool-call p50 \d+ ms \(<= 60\), p95 \d+ ms \(<= 150\)/u,
  );
  assert.equal(run.status, run.stdout.includes('PASS') ? 0 : 1);
});
