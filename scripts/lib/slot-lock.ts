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
  /** How long to wait for a slot before giving up with a SlotTimeoutError; unset waits forever. */
  deadlineMs?: number;
  /** Called once, with the pid of a holder, when every slot is taken and the caller starts to wait. */
  onWait?: (holderPid: number | undefined) => void;
};

/** Exit code a command uses when the slot wait ran past its deadline (the repository timeout code). */
export const SLOT_TIMEOUT_EXIT = 75;

/** The wait for a slot ended at its deadline while every slot still had a live holder. */
export class SlotTimeoutError extends Error {
  readonly exitCode = SLOT_TIMEOUT_EXIT;
  readonly waitedMs: number;
  readonly holderPid: number | undefined;
  constructor(waitedMs: number, holderPid: number | undefined) {
    super(
      `no host test slot after ${Math.round(waitedMs / 1000)}s${holderPid ? ` (held by pid ${holderPid})` : ''}`,
    );
    this.name = 'SlotTimeoutError';
    this.waitedMs = waitedMs;
    this.holderPid = holderPid;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Start time of a process in clock ticks since boot (/proc stat field 22), or undefined where /proc has none. */
export function processStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name may hold spaces and parentheses; fields resume after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] || undefined;
  } catch {
    return undefined;
  }
}

type Holder = { pid: number; start: string | undefined };

function holder(slot: string): Holder | undefined {
  try {
    const [first, start] = readFileSync(join(slot, 'pid'), 'utf8')
      .trim()
      .split(/\s+/);
    const pid = Number(first);
    return Number.isInteger(pid) && pid > 0 ? { pid, start } : undefined;
  } catch {
    return undefined;
  }
}

/** A holder is live only while its pid exists and, when a start time was recorded, is still the same process. */
function holding(entry: Holder): boolean {
  if (!alive(entry.pid)) return false;
  const now = processStart(entry.pid);
  return entry.start === undefined || now === undefined || now === entry.start;
}

/** Takes a free slot (reclaiming one whose holder died) and returns its release. */
async function acquire(options: SlotOptions): Promise<() => void> {
  const slots = Math.max(1, options.slots ?? 1);
  const pollMs = options.pollMs ?? 250;
  mkdirSync(options.dir, { recursive: true });
  const started = Date.now();
  let waiting = false;
  for (;;) {
    for (let index = 0; index < slots; index += 1) {
      const slot = join(options.dir, `slot-${index}`);
      try {
        mkdirSync(slot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const entry = holder(slot);
        // A fresh slot has no pid yet; only a recorded dead or replaced holder is reclaimed.
        if (entry === undefined || holding(entry)) continue;
        rmSync(slot, { recursive: true, force: true });
        index -= 1;
        continue;
      }
      writeFileSync(
        join(slot, 'pid'),
        `${process.pid} ${processStart(process.pid) ?? ''}`.trim(),
      );
      return () => rmSync(slot, { recursive: true, force: true });
    }
    if (!waiting) {
      waiting = true;
      options.onWait?.(holder(join(options.dir, 'slot-0'))?.pid);
    }
    const waited = Date.now() - started;
    if (options.deadlineMs !== undefined && waited >= options.deadlineMs)
      throw new SlotTimeoutError(
        waited,
        holder(join(options.dir, 'slot-0'))?.pid,
      );
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
