// The replay arms are configuration: each names how the unit's workspace is prepared, nothing else.
// A: plain clone. B: the in-force records rendered to a static CLAUDE.md, token-matched to C's injection.
// C: KRN (hooks, brain packet, skills). A': arm A's configuration under its own id, the A/A noise floor.
import { createHash } from 'node:crypto';

/** The confirmatory arms: the ones a contrast, a verdict or a Holm family can name. */
export type ArmId = 'A' | 'B' | 'C';
/** Every arm a row can carry: the confirmatory arms and the A/A replicate A'. */
export type RowArm = ArmId | "A'";

export interface Arm {
  id: RowArm;
  describe: string;
  /** Static instruction file rendered from the in-force records. */
  staticRecords: boolean;
  /** KRN hooks and brain injection active in the session. */
  krn: boolean;
}

export const ARMS: Readonly<Record<RowArm, Arm>> = {
  A: { id: 'A', describe: 'plain clone', staticRecords: false, krn: false },
  B: {
    id: 'B',
    describe: 'in-force records as a static CLAUDE.md, token-matched',
    staticRecords: true,
    krn: false,
  },
  C: { id: 'C', describe: 'KRN', staticRecords: false, krn: true },
  "A'": {
    id: "A'",
    describe: 'plain clone, the A/A replicate',
    staticRecords: false,
    krn: false,
  },
};

/** The seed of the per-(unit, rep) arm order; the order is a pure function of it, the unit and the rep. */
export const ORDER_SEED = 'abc-arm-order';

/**
 * The order `arms` run back to back for one unit and rep: a Fisher-Yates shuffle drawn from a hash of
 * (seed, unit, rep), so the same seed gives the same order and no arm systematically runs first or last.
 */
export function armOrder<T>(
  arms: readonly T[],
  unit: string,
  rep: number,
  seed: string = ORDER_SEED,
): T[] {
  const bytes = createHash('sha256')
    .update(`${seed}\n${unit}\n${rep}`)
    .digest();
  const out = [...arms];
  for (let i = out.length - 1; i > 0; i--) {
    const j = (bytes[out.length - 1 - i] as number) % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export function parseArms(list: string): Arm[] {
  return list.split(',').map((raw) => {
    const id = raw.trim() as RowArm;
    const arm = ARMS[id];
    if (!arm) throw new Error(`unknown arm: ${raw}`);
    return arm;
  });
}
