import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inTestSlot } from '../../scripts/fast-check.ts';

function gate(): { open: () => void; opened: Promise<void> } {
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

test('two concurrent fast runs with slots=1 run one after the other and the second prints its wait', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fast-slots-'));
  try {
    const env = { KRN_FAST_SLOTS: '1', KRN_FAST_SLOT_DIR: dir };
    const events: string[] = [];
    const messages: string[] = [];
    const aStarted = gate();
    const bWaits = gate();
    const a = inTestSlot(
      process.cwd(),
      async () => {
        events.push('a start');
        aStarted.open();
        await bWaits.opened;
        events.push('a end');
      },
      env,
      (text) => messages.push(`a: ${text}`),
    );
    await aStarted.opened;
    const b = inTestSlot(
      process.cwd(),
      async () => {
        events.push('b start');
        events.push('b end');
      },
      env,
      (text) => {
        messages.push(`b: ${text}`);
        bWaits.open();
      },
    );
    await Promise.all([a, b]);
    assert.deepEqual(events, ['a start', 'a end', 'b start', 'b end']);
    assert.equal(messages.filter((m) => m.startsWith('a:')).length, 0);
    assert.match(messages.join(''), /b: fast: waiting for a host test slot/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two slots let two fast runs overlap and nobody waits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fast-slots-'));
  try {
    const env = { KRN_FAST_SLOTS: '2', KRN_FAST_SLOT_DIR: dir };
    const messages: string[] = [];
    const bothIn = gate();
    let live = 0;
    const lane = (): Promise<void> =>
      inTestSlot(
        process.cwd(),
        async () => {
          if (++live === 2) bothIn.open();
          await bothIn.opened;
        },
        env,
        (text) => messages.push(text),
      );
    await Promise.all([lane(), lane()]);
    assert.equal(live, 2);
    assert.deepEqual(messages, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a nested slot request inside a held slot runs at once instead of queueing behind itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fast-slots-'));
  try {
    // slots=1: before the fix a second acquisition in the same run waited (guard, then tsc+tests).
    const env = { KRN_FAST_SLOTS: '1', KRN_FAST_SLOT_DIR: dir };
    const messages: string[] = [];
    const write = (text: string): void => {
      messages.push(text);
    };
    const inner = await inTestSlot(
      process.cwd(),
      () =>
        inTestSlot(process.cwd(), async () => 'nested', env, write).then(
          async (first) =>
            `${first}+${await inTestSlot(process.cwd(), async () => 'again', env, write)}`,
        ),
      env,
      write,
    );
    assert.equal(inner, 'nested+again');
    assert.deepEqual(messages, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a slot held by a live process that waits past the deadline ends the wait with the timeout exit code', async () => {
  const { SLOT_TIMEOUT_EXIT, SlotTimeoutError, withSlot } = await import(
    '../../src/repo/slot-lock.ts'
  );
  assert.equal(typeof SlotTimeoutError, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'fast-slots-'));
  try {
    const held = gate();
    const release = gate();
    const holder = withSlot({ dir, pollMs: 5 }, async () => {
      held.open();
      await release.opened;
    });
    await held.opened;
    const error = await withSlot(
      { dir, pollMs: 5, deadlineMs: 50 },
      async () => 'never',
    ).catch((caught: unknown) => caught);
    assert.ok(error instanceof SlotTimeoutError);
    assert.equal(error.exitCode, SLOT_TIMEOUT_EXIT);
    assert.equal(error.holderPid, process.pid);
    assert.match(
      error.message,
      /no host test slot after \d+s \(held by pid \d+\)/,
    );
    release.open();
    await holder;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a slot whose recorded holder pid is dead is reclaimed at once', async () => {
  const { withSlot } = await import('../../src/repo/slot-lock.ts');
  const dir = mkdtempSync(join(tmpdir(), 'fast-slots-'));
  try {
    mkdirSync(join(dir, 'slot-0'));
    writeFileSync(join(dir, 'slot-0', 'pid'), '999999999 12345');
    const ran = await withSlot(
      { dir, pollMs: 5000, deadlineMs: 2000 },
      async () => 'ok',
    );
    assert.equal(ran, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a slot whose pid now belongs to a different process is reclaimed at once', async () => {
  const { withSlot, processStart } = await import(
    '../../src/repo/slot-lock.ts'
  );
  assert.equal(typeof processStart, 'function');
  if (processStart(process.pid) === undefined) return;
  const dir = mkdtempSync(join(tmpdir(), 'fast-slots-'));
  try {
    mkdirSync(join(dir, 'slot-0'));
    // This pid is alive, but the recorded start time is not its own: the pid was reused.
    writeFileSync(join(dir, 'slot-0', 'pid'), `${process.pid} 1`);
    const ran = await withSlot(
      { dir, pollMs: 5000, deadlineMs: 2000 },
      async () => 'ok',
    );
    assert.equal(ran, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a slot recorded with this process start time stays held', async () => {
  const { withSlot, processStart } = await import(
    '../../src/repo/slot-lock.ts'
  );
  assert.equal(typeof processStart, 'function');
  if (processStart(process.pid) === undefined) return;
  const dir = mkdtempSync(join(tmpdir(), 'fast-slots-'));
  try {
    mkdirSync(join(dir, 'slot-0'));
    writeFileSync(
      join(dir, 'slot-0', 'pid'),
      `${process.pid} ${processStart(process.pid)}`,
    );
    await assert.rejects(
      withSlot({ dir, pollMs: 5, deadlineMs: 40 }, async () => 'never'),
      { name: 'SlotTimeoutError' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fast run whose environment marks a held slot runs at once even when the gate is full', async () => {
  const { withSlot } = await import('../../src/repo/slot-lock.ts');
  const dir = mkdtempSync(join(tmpdir(), 'fast-slots-'));
  try {
    const env = {
      KRN_FAST_SLOTS: '1',
      KRN_FAST_SLOT_DEADLINE_MS: '100',
      KRN_FAST_SLOT_DIR: dir,
      KRN_TEST_SLOT_HELD: '1',
    };
    const messages: string[] = [];
    const ran = await withSlot({ dir, slots: 1 }, () =>
      inTestSlot(
        process.cwd(),
        async () => 'inside',
        env,
        (text) => messages.push(text),
      ),
    );
    assert.equal(ran, 'inside');
    assert.deepEqual(messages, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
