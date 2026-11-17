import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type DrainSeams,
  doctorArgs,
  drainReady,
  parseDrainRequest,
} from '../../src/cli/lane-run/drain.ts';

function batch(queue: string[], exits: Record<string, number>): DrainSeams {
  return {
    doctor: () => ({ text: '', exitCode: 0 }),
    nextReady: async (_root, skip) => queue.find((id) => !skip.has(id)),
    runTask: async (id) => ({ line: id, exitCode: exits[id] ?? 0 }),
    now: () => 0,
  };
}
const request = { max: 2, passthrough: [], root: process.cwd() };

test('a mixed batch whose last task merged still exits non-zero and names the failed task', async () => {
  const result = await drainReady(
    request,
    batch(['t-a', 't-b'], { 't-a': 74, 't-b': 0 }),
  );
  assert.equal(result.exitCode, 74);
  assert.ok(result.lines.includes('drain: failed t-a (exit 74)'));
});

test('a batch names every failed task', async () => {
  const result = await drainReady(
    { ...request, max: 3 },
    batch(['t-a', 't-b', 't-c'], { 't-a': 74, 't-b': 0, 't-c': 73 }),
  );
  assert.equal(result.exitCode, 73);
  assert.ok(
    result.lines.includes('drain: failed t-a (exit 74), t-c (exit 73)'),
  );
});

test('a batch that all merged exits 0 without a failure line', async () => {
  const result = await drainReady(request, batch(['t-a', 't-b'], {}));
  assert.equal(result.exitCode, 0);
  assert.ok(!result.lines.some((line) => line.startsWith('drain: failed')));
});

test('the batch doctor receives the target root and the window', () => {
  const parsed = parseDrainRequest([
    '--ready',
    '--max',
    '1',
    '--root',
    '/target',
    '--window-hours',
    '3',
  ]);
  assert.deepEqual(doctorArgs(parsed.windowHours, parsed.root), [
    '--unattended',
    '--window-hours',
    '3',
    '--root',
    '/target',
  ]);
  assert.deepEqual(doctorArgs(), ['--unattended']);
});
