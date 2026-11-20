// Shared slot lock: heavy jobs of every checkout take turns by weight instead of all saturating the host.
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export type SlotOptions = {
  /** Directory holding the slot directories; shared by every checkout of the host. */
  dir: string;
  /** Capacity in weight units: the summed weight of live holders never exceeds it, except a lone holder. */
  slots?: number;
  /** Units this holder takes; 1 by default, so `slots` counts holders. */
  weight?: number | undefined;
  /** Poll interval while the capacity is taken. */
  pollMs?: number;
  /** How long to wait for a slot before giving up with a SlotTimeoutError; unset waits forever. */
  deadlineMs?: number | undefined;
  /** Asked only while another holder runs, with the live holders and the weight asking in: a reason to wait (host load, memory), or undefined to admit. */
  pressure?: ((admission: Admission) => string | undefined) | undefined;
  /** Called once, with the pid of a holder, when the caller starts to wait. */
  onWait?: (holderPid: number | undefined, reason: string) => void;
  /**
   * withSlot only: the most milliseconds the slot is held; past it the slot is released while the work
   * runs on, so a job that never ends (a watcher, a server) cannot hold a slot for its whole life.
   */
  leaseMs?: number | undefined;
  /** Called once when the lease releases the slot early. */
  onLease?: () => void;
};

/** The longest delay setTimeout honours; a larger one fires after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Exit code a command uses when the slot wait ran past its deadline (the repository timeout code). */
export const SLOT_TIMEOUT_EXIT = 75;

/** The wait for a slot ended at its deadline while live holders still took the capacity. */
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

type Holder = { pid: number; start: string | undefined; weight: number };

/** The text of a pid file, or '' when none is written yet. */
function recordText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** The holder recorded in a pid file (`pid [start [weight]]`), or undefined when none is recorded yet. */
function holder(path: string): Holder | undefined {
  return parseHolder(recordText(path));
}

function parseHolder(text: string): Holder | undefined {
  const [first, start, units] = text.trim().split(/\s+/);
  const pid = Number(first);
  const weight = Number(units);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return {
    pid,
    start: start && start !== '-' ? start : undefined,
    weight: Number.isInteger(weight) && weight > 0 ? weight : 1,
  };
}

/** A holder is live only while its pid exists and, when a start time was recorded, is still the same process. */
function holding(entry: Holder): boolean {
  if (!alive(entry.pid)) return false;
  const now = processStart(entry.pid);
  return entry.start === undefined || now === undefined || now === entry.start;
}

/** Milliseconds since a slot was taken (its directory's mtime); 0 when it vanished meanwhile. */
function slotAge(slot: string, now: number): number {
  try {
    return Math.max(0, now - statSync(slot).mtimeMs);
  } catch {
    return 0;
  }
}

function record(weight: number): string {
  return `${process.pid} ${processStart(process.pid) ?? '-'} ${weight}`;
}

/**
 * Longest a mutex or slot directory may stand without a pid record before it counts as abandoned: its
 * taker writes the record right after mkdir, so a directory still bare after this died in between.
 */
const RECORD_STALE_MS = 5_000;

/** One mutex directory as judged: what identifies it (inode, mtime, record) and whether its owner is gone. */
function judgeMutex(
  path: string,
): { id: string; abandoned: boolean } | undefined {
  try {
    const { ino, mtimeMs } = statSync(path);
    const text = recordText(join(path, 'pid'));
    const owner = parseHolder(text);
    return {
      id: `${ino}:${mtimeMs}:${text}`,
      abandoned: owner
        ? !holding(owner)
        : Date.now() - mtimeMs > RECORD_STALE_MS,
    };
  } catch {
    return undefined;
  }
}

/**
 * Removes an abandoned mutex. Check-then-delete on the shared name could remove a mutex another waiter
 * had already reclaimed and a live pass had taken since, letting two passes admit at once; so the
 * mutex moves to a private name first, and only the directory judged abandoned is removed. Another
 * one is put back; if a new mutex took the name in that instant, two passes overlap once.
 */
function reclaimMutex(dir: string, mutex: string): void {
  const judged = judgeMutex(mutex);
  if (!judged?.abandoned) return;
  const moved = join(dir, `.mutex-reclaim-${process.pid}-${randomUUID()}`);
  try {
    renameSync(mutex, moved);
  } catch {
    // Another waiter moved it first.
    return;
  }
  if (judgeMutex(moved)?.id !== judged.id)
    try {
      renameSync(moved, mutex);
      return;
    } catch {
      // A new mutex holds the name: the moved one's owner releases by record, so removing it is safe.
    }
  rmSync(moved, { recursive: true, force: true });
}

/** Takes the admission mutex (one short critical section per pass), or returns undefined when another pass holds it. */
function lockMutex(dir: string): (() => void) | undefined {
  const mutex = join(dir, '.mutex');
  try {
    mkdirSync(mutex);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    reclaimMutex(dir, mutex);
    return undefined;
  }
  const mine = record(1);
  try {
    writeFileSync(join(mutex, 'pid'), mine);
  } catch {
    // Moved away before the record was written: this pass does not hold it.
    return undefined;
  }
  // Released by record: a mutex that is no longer this pass's own is never removed.
  return () => {
    if (recordText(join(mutex, 'pid')) === mine)
      rmSync(mutex, { recursive: true, force: true });
  };
}

/** A live holder's weight and how long ago it took its slot. */
export type HeldSlot = { weight: number; ageMs: number };

/** What a pressure probe is asked about: the holders already running and the weight of the job asking in. */
export type Admission = { held: HeldSlot[]; weight: number };

type Pass =
  | { kind: 'taken'; release: () => void }
  | { kind: 'wait'; holderPid: number | undefined; reason: string };

/** One admission pass under the mutex: reclaims dead holders, then takes a slot when the weight fits and the host has room. */
function tryTake(options: SlotOptions): Pass {
  const capacity = Math.max(1, options.slots ?? 1);
  const weight = Math.min(capacity, Math.max(1, options.weight ?? 1));
  mkdirSync(options.dir, { recursive: true });
  const unlock = lockMutex(options.dir);
  if (!unlock)
    return { kind: 'wait', holderPid: undefined, reason: 'admission busy' };
  try {
    const taken = new Set<number>();
    const held: HeldSlot[] = [];
    const now = Date.now();
    let used = 0;
    let first: number | undefined;
    for (const name of readdirSync(options.dir)) {
      const match = /^slot-(\d+)$/.exec(name);
      if (!match) continue;
      const slot = join(options.dir, name);
      const entry = holder(join(slot, 'pid'));
      // A dead or replaced holder is reclaimed, and so is a slot left without a record past RECORD_STALE_MS
      // (its taker died between mkdir and the record); a fresher bare slot is still being written.
      const abandoned =
        entry === undefined
          ? slotAge(slot, now) > RECORD_STALE_MS
          : !holding(entry);
      if (abandoned) {
        rmSync(slot, { recursive: true, force: true });
        continue;
      }
      taken.add(Number(match[1]));
      used += entry?.weight ?? 1;
      held.push({ weight: entry?.weight ?? 1, ageMs: slotAge(slot, now) });
      first ??= entry?.pid;
    }
    if (used > 0 && used + weight > capacity)
      return {
        kind: 'wait',
        holderPid: first,
        reason: `capacity ${used}+${weight} > ${capacity}`,
      };
    const pressure =
      used > 0 ? options.pressure?.({ held, weight }) : undefined;
    if (pressure) return { kind: 'wait', holderPid: first, reason: pressure };
    let index = 0;
    while (taken.has(index)) index += 1;
    const slot = join(options.dir, `slot-${index}`);
    mkdirSync(slot);
    const mine = record(weight);
    writeFileSync(join(slot, 'pid'), mine);
    const inode = statSync(join(slot, 'pid')).ino;
    let released = false;
    return {
      kind: 'taken',
      // Once only, and only while the slot is still ours: after an early release (a lease) another job
      // may hold the same slot-N, and a second release must not delete its slot.
      release: () => {
        if (released) return;
        released = true;
        let current: string | undefined;
        try {
          current = readFileSync(join(slot, 'pid'), 'utf8');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') return;
          // A record its owner made unreadable is still ours while it is the file we wrote.
          if (code !== 'EACCES') throw error;
          if (statSync(join(slot, 'pid')).ino === inode) current = mine;
        }
        if (current === mine) rmSync(slot, { recursive: true, force: true });
      },
    };
  } finally {
    unlock();
  }
}

/** After a failed pass: reports the first wait once and throws at the deadline. */
function stillWaiting(
  options: SlotOptions,
  pass: { holderPid: number | undefined; reason: string },
  started: number,
  waiting: boolean,
): void {
  if (!waiting) options.onWait?.(pass.holderPid, pass.reason);
  const waited = Date.now() - started;
  if (options.deadlineMs !== undefined && waited >= options.deadlineMs)
    throw new SlotTimeoutError(waited, pass.holderPid);
}

async function acquire(options: SlotOptions): Promise<() => void> {
  const pollMs = options.pollMs ?? 250;
  const started = Date.now();
  let waiting = false;
  for (;;) {
    const pass = tryTake(options);
    if (pass.kind === 'taken') return pass.release;
    stillWaiting(options, pass, started, waiting);
    waiting = true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Blocking twin of withSlot for synchronous callers (the Stop hook spawns its tests with spawnSync). */
export function withSlotSync<T>(options: SlotOptions, work: () => T): T {
  const pollMs = options.pollMs ?? 250;
  const started = Date.now();
  const cell = new Int32Array(new SharedArrayBuffer(4));
  let waiting = false;
  let pass = tryTake(options);
  while (pass.kind === 'wait') {
    stillWaiting(options, pass, started, waiting);
    waiting = true;
    Atomics.wait(cell, 0, 0, pollMs);
    pass = tryTake(options);
  }
  try {
    return work();
  } finally {
    pass.release();
  }
}

/** Runs the work while holding one slot; the slot is released on success or failure. */
export async function withSlot<T>(
  options: SlotOptions,
  work: () => Promise<T>,
): Promise<T> {
  const release = await acquire(options);
  const lease =
    options.leaseMs === undefined
      ? undefined
      : setTimeout(
          () => {
            release();
            options.onLease?.();
          },
          // setTimeout fires at once past its 32-bit limit: a longer lease is held to the limit (about 24.8 days).
          Math.min(options.leaseMs, MAX_TIMER_MS),
        );
  lease?.unref();
  try {
    return await work();
  } finally {
    clearTimeout(lease);
    release();
  }
}

/** Live holders of a slot directory, for status reports and capacity checks. */
export function slotHolders(dir: string): Holder[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^slot-\d+$/.test(name))
    .map((name) => holder(join(dir, name, 'pid')))
    .filter((entry): entry is Holder => entry !== undefined && holding(entry));
}
