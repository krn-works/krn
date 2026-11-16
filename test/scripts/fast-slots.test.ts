import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
