import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Lane starts in tests must not depend on how busy the machine running them is: admit every lane
 * whatever the load and memory, against an empty heavy-job gate. The capacity refusal itself is
 * tested with an injected probe.
 */
export function admitLanesOnAnyHost(): void {
  process.env.KRN_LANE_LOAD_PER_CORE = '1000000';
  process.env.KRN_LANE_MIN_MB = '0';
  process.env.KRN_HEAVY_GATE_DIR = mkdtempSync(
    join(tmpdir(), 'krn-lane-gate-'),
  );
}
