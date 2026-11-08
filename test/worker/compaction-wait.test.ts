import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { awaitCompaction, type Frames } from '../../src/worker/compaction.ts';
import { WorkerError } from '../../src/worker/state.ts';

type Frame = { method?: string; params?: Record<string, unknown> };

// KRN-12: the inbound frames codex 0.167.0 sent after thread/compact/start
// (codex-app-server/compact.rpc), in order, up to its compaction turn/completed.
const rpc = (name: string) =>
  readFileSync(
    new URL(`../fixtures/codex-app-server/${name}.rpc`, import.meta.url),
    'utf8',
  ).split('\n');
const compact = rpc('compact');
const start = compact.findIndex((line) =>
  line.includes('"method":"thread/compact/start"'),
);
const recorded: Frame[] = compact
  .slice(start + 1)
  .filter((line) => line.startsWith('< {"method"'))
  .map((line) => JSON.parse(line.slice(2)));
const threadId = String(recorded[0]?.params?.threadId);
const completion = recorded.findIndex((f) => f.method === 'turn/completed');
const compactionTurn = recorded[completion]?.params?.turn as { id: string };

/** Gated frames: a wait resolves only from frames the test has released. */
function gate() {
  const released: Frame[] = [];
  const waits: {
    predicate: (f: Frame) => boolean;
    done: (f: Frame) => void;
  }[] = [];
  const frames: Frames = {
    wait: (predicate) =>
      new Promise((done) => {
        const found = released.find(predicate);
        if (found) done(found);
        else waits.push({ predicate, done });
      }),
  };
  const release = (...more: Frame[]) => {
    released.push(...more);
    for (const wait of waits.splice(0)) {
      const found = released.find(wait.predicate);
      if (found) wait.done(found);
      else waits.push(wait);
    }
  };
  return { frames, release };
}

// A clock the test owns: the round deadline moves only when the test says so.
const clock = { now: 0 };
const remaining = () => 30 * 60_000 - clock.now;
const never = () => false;

async function state(promise: Promise<unknown>) {
  let settled = 'pending';
  promise.then(
    () => {
      settled = 'resolved';
    },
    () => {
      settled = 'rejected';
    },
  );
  await new Promise((done) => setImmediate(done));
  return settled;
}

test('compaction waits for its own turn/completed after the compaction item', async () => {
  assert.ok(completion > 0, 'compact.rpc holds a compaction turn/completed');
  const { frames, release } = gate();
  const done = awaitCompaction(frames, threadId, remaining, never);
  // Everything up to the held-back turn/completed, compaction item included.
  release(...recorded.slice(0, completion));
  assert.equal(await state(done), 'pending');
  release(recorded[completion] as Frame);
  assert.equal(await state(done), 'resolved');
  await done;
});

test('a failed compaction turn exits 75 with its failure class at once', async () => {
  // Synthetic: the failed turn/completed of failed-turn.rpc, the only
  // recorded failed-turn shape, moved onto the recorded compaction turn.
  const failed = JSON.parse(
    rpc('failed-turn')
      .find((line) => line.includes('"status":"failed"'))
      ?.slice(2) ?? '{}',
  ) as Frame;
  const frame = {
    ...failed,
    params: {
      ...failed.params,
      threadId,
      turn: {
        ...(failed.params?.turn as object),
        id: compactionTurn.id,
      },
    },
  };
  const { frames, release } = gate();
  const before = clock.now;
  const done = awaitCompaction(frames, threadId, remaining, never);
  release(...recorded.slice(0, completion), frame);
  await assert.rejects(done, (error: unknown) => {
    assert.ok(error instanceof WorkerError);
    assert.equal(error.exitCode, 75);
    assert.match(error.message, /modelNotFound/);
    assert.deepEqual(error.failure, {
      class: 'modelNotFound',
      retryable: false,
    });
    return true;
  });
  assert.equal(clock.now, before, 'the round deadline did not advance');
});

test('a failed compaction turn without a compaction item still exits 75', async () => {
  const { frames, release } = gate();
  const done = awaitCompaction(frames, threadId, remaining, never);
  release({
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: compactionTurn.id, status: 'interrupted', error: null },
    },
  });
  await assert.rejects(done, { exitCode: 75 });
});

test('the deprecated thread/compacted completes without a compaction turn', async () => {
  const { frames, release } = gate();
  const done = awaitCompaction(frames, threadId, remaining, never);
  release({ method: 'thread/compacted', params: { threadId } });
  assert.equal(await state(done), 'resolved');
});

test("another thread's compaction frames do not end the wait", async () => {
  const { frames, release } = gate();
  const done = awaitCompaction(frames, threadId, remaining, never);
  release(
    ...recorded.map((frame) => ({
      ...frame,
      params: { ...frame.params, threadId: 'other-thread' },
    })),
  );
  assert.equal(await state(done), 'pending');
  release(...recorded);
  await done;
});
