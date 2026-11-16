// Shared slot lock: concurrent fast checks take turns on the heavy test phase instead of all saturating the host.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type SlotOptions = {
  /** Directory holding the slot directories; shared by every checkout of the host. */
  dir: string;
  /** How many holders may run at once. */
  slots?: number;
  /** Poll interval while every slot is taken. */
  pollMs?: number;
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function holder(slot: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(slot, 'pid'), 'utf8'));
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Takes a free slot (reclaiming one whose holder died) and returns its release. */
async function acquire(options: SlotOptions): Promise<() => void> {
  const slots = Math.max(1, options.slots ?? 1);
  const pollMs = options.pollMs ?? 250;
  mkdirSync(options.dir, { recursive: true });
  for (;;) {
    for (let index = 0; index < slots; index += 1) {
      const slot = join(options.dir, `slot-${index}`);
      try {
        mkdirSync(slot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const pid = holder(slot);
        if (pid !== undefined && alive(pid)) continue;
        // A fresh slot has no pid yet; only a recorded dead holder is reclaimed.
        if (pid === undefined) continue;
        rmSync(slot, { recursive: true, force: true });
        index -= 1;
        continue;
      }
      writeFileSync(join(slot, 'pid'), String(process.pid));
      return () => rmSync(slot, { recursive: true, force: true });
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Runs the work while holding one slot; the slot is released on success or failure. */
export async function withSlot<T>(
  options: SlotOptions,
  work: () => Promise<T>,
): Promise<T> {
  const release = await acquire(options);
  try {
    return await work();
  } finally {
    release();
  }
}
