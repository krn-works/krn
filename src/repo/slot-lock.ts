// Shared slot lock: heavy jobs of every checkout take turns by weight instead of all saturating the host.
import {
  mkdirSync,
  readdirSync,
  readFileSync,
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
  /** Asked only while another holder runs: a reason to wait (host load, memory), or undefined to admit. */
  pressure?: (() => string | undefined) | undefined;
  /** Called once, with the pid of a holder, when the caller starts to wait. */
  onWait?: (holderPid: number | undefined, reason: string) => void;
};

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

/** The holder recorded in a pid file (`pid [start [weight]]`), or undefined when none is recorded yet. */
function holder(path: string): Holder | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
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

function record(weight: number): string {
  return `${process.pid} ${processStart(process.pid) ?? '-'} ${weight}`;
}

/** Longest a mutex may stand without a live recorded owner before it counts as abandoned. */
const MUTEX_STALE_MS = 5_000;

/** Takes the admission mutex (one short critical section per pass), or returns undefined when another pass holds it. */
function lockMutex(dir: string): (() => void) | undefined {
  const mutex = join(dir, '.mutex');
  try {
    mkdirSync(mutex);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = holder(join(mutex, 'pid'));
    let age = 0;
    try {
      age = Date.now() - statSync(mutex).mtimeMs;
    } catch {
      // Released between our mkdir and stat: the next pass takes it.
      return undefined;
    }
    const abandoned = owner ? !holding(owner) : age > MUTEX_STALE_MS;
    if (abandoned) rmSync(mutex, { recursive: true, force: true });
    return undefined;
  }
  writeFileSync(join(mutex, 'pid'), record(1));
  return () => rmSync(mutex, { recursive: true, force: true });
}

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
    let used = 0;
    let first: number | undefined;
    for (const name of readdirSync(options.dir)) {
      const match = /^slot-(\d+)$/.exec(name);
      if (!match) continue;
      const slot = join(options.dir, name);
      const entry = holder(join(slot, 'pid'));
      // A slot without a recorded pid is still being written; only a dead or replaced holder is reclaimed.
      if (entry !== undefined && !holding(entry)) {
        rmSync(slot, { recursive: true, force: true });
        continue;
      }
      taken.add(Number(match[1]));
      used += entry?.weight ?? 1;
      first ??= entry?.pid;
    }
    if (used > 0 && used + weight > capacity)
      return {
        kind: 'wait',
        holderPid: first,
        reason: `capacity ${used}+${weight} > ${capacity}`,
      };
    const pressure = used > 0 ? options.pressure?.() : undefined;
    if (pressure) return { kind: 'wait', holderPid: first, reason: pressure };
    let index = 0;
    while (taken.has(index)) index += 1;
    const slot = join(options.dir, `slot-${index}`);
    mkdirSync(slot);
    writeFileSync(join(slot, 'pid'), record(weight));
    return {
      kind: 'taken',
      release: () => rmSync(slot, { recursive: true, force: true }),
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
  try {
    return await work();
  } finally {
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
