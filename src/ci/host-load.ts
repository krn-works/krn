import { cpus, loadavg } from 'node:os';

/** The longest a local check waits for a quiet host; a busier host runs the check after this. */
export const quietHostBoundMs = 10 * 60 * 1000;

export interface QuietHostOptions {
  /** The 1-minute load average. */
  load?: () => number;
  cores?: number;
  /** Blocks for the given milliseconds. */
  sleep?: (ms: number) => void;
  boundMs?: number;
  pollMs?: number;
  write?: (text: string) => void;
}

const blockFor = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Waits, up to the bound, until the 1-minute load average is below the core count, so a finished
 * attempt's check does not time out against other projects' work. Returns the milliseconds waited.
 * The host test slot (scripts/fast-check.ts) still serialises the heavy phase; this only defers its start.
 */
export function waitForQuietHost(options: QuietHostOptions = {}): number {
  const load = options.load ?? (() => loadavg()[0] ?? 0);
  const cores = options.cores ?? cpus().length;
  const sleep = options.sleep ?? blockFor;
  const bound = options.boundMs ?? quietHostBoundMs;
  const poll = Math.max(1, options.pollMs ?? 15_000);
  const write = options.write ?? ((text) => process.stderr.write(text));
  let waited = 0;
  let announced = false;
  while (load() >= cores && waited < bound) {
    if (!announced) {
      write(
        `check: waiting for the host load (${load().toFixed(1)}) to fall below ${cores} cores, at most ${Math.round(bound / 1000)}s\n`,
      );
      announced = true;
    }
    const step = Math.min(poll, bound - waited);
    sleep(step);
    waited += step;
  }
  return waited;
}
