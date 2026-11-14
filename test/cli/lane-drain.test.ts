import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type DrainSeams,
  drainReady,
  parseDrainRequest,
} from '../../src/cli/lane-run/drain.ts';

function seams(
  queue: string[],
  exits: Record<string, number>,
  doctorExit = 0,
): { seams: DrainSeams; ran: Array<{ id: string; args: string[] }> } {
  const ran: Array<{ id: string; args: string[] }> = [];
  let clock = 0;
  return {
    ran,
    seams: {
      doctor: () => ({ text: 'doctor says', exitCode: doctorExit }),
      nextReady: async (_root, skip) => queue.find((id) => !skip.has(id)),
      runTask: async (id, args) => {
        ran.push({ id, args });
        clock += 5000;
        return { line: id, exitCode: exits[id] ?? 0 };
      },
      now: () => clock,
    },
  };
}
const request = (max: number) => ({
  max,
  passthrough: ['--actor', 'a'],
  root: process.cwd(),
});

test('drain runs ready tasks serially in queue order and prints one line each', async () => {
  const { seams: s, ran } = seams(['t-a', 't-b', 't-c'], {});
  const result = await drainReady(request(3), s);
  assert.deepEqual(
    ran.map((r) => r.id),
    ['t-a', 't-b', 't-c'],
  );
  assert.deepEqual(ran[0]?.args, ['--actor', 'a']);
  assert.deepEqual(result.lines, [
    't-a t-a exit=0 5s',
    't-b t-b exit=0 5s',
    't-c t-c exit=0 5s',
  ]);
  assert.equal(result.exitCode, 0);
});

test('drain stops at max', async () => {
  const { seams: s, ran } = seams(['t-a', 't-b', 't-c'], {});
  await drainReady(request(2), s);
  assert.equal(ran.length, 2);
});

test('drain stops after two consecutive failures of the same exit class', async () => {
  const { seams: s, ran } = seams(['t-a', 't-b', 't-c', 't-d'], {
    't-a': 74,
    't-b': 74,
  });
  const result = await drainReady(request(4), s);
  assert.equal(ran.length, 2);
  assert.equal(result.exitCode, 74);
  assert.match(
    result.lines.at(-1) ?? '',
    /stopped after 2 consecutive exit 74/u,
  );
});

test('drain goes on when failures differ or a success intervenes', async () => {
  const { seams: s, ran } = seams(['t-a', 't-b', 't-c', 't-d'], {
    't-a': 74,
    't-b': 73,
    't-c': 74,
  });
  await drainReady(request(4), s);
  assert.equal(ran.length, 4);
  const { seams: s2, ran: ran2 } = seams(['t-a', 't-b', 't-c'], {
    't-a': 74,
    't-c': 74,
  });
  await drainReady(request(3), s2);
  assert.equal(ran2.length, 3);
});

test('a failing doctor stops the drain before any claim', async () => {
  const { seams: s, ran } = seams(['t-a'], {}, 69);
  const result = await drainReady(request(3), s);
  assert.equal(ran.length, 0);
  assert.equal(result.exitCode, 69);
  assert.match(
    result.lines[0] ?? '',
    /doctor --unattended failed \(exit 69\)/u,
  );
});

test('an empty queue ends the drain with exit 0', async () => {
  const { seams: s } = seams([], {});
  const result = await drainReady(request(3), s);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.lines, ['drain: no ready task left']);
});

test('parseDrainRequest needs --max and passes actor, model and root through', () => {
  assert.throws(() => parseDrainRequest(['--ready']), /--max/u);
  assert.throws(
    () => parseDrainRequest(['--ready', '--max', '0']),
    /positive/u,
  );
  assert.throws(() =>
    parseDrainRequest(['--ready', '--max', '2', '--task', 't-x']),
  );
  const parsed = parseDrainRequest([
    '--ready',
    '--max',
    '2',
    '--actor',
    'w',
    '--model',
    'm',
    '--root',
    '/r',
  ]);
  assert.equal(parsed.max, 2);
  assert.deepEqual(parsed.passthrough, [
    '--actor',
    'w',
    '--model',
    'm',
    '--root',
    '/r',
  ]);
});
